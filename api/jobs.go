package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"job_scheduler/internal/sqljob"

	"github.com/jackc/pgx/v5/pgxpool"
)

type jobsHandler struct {
	db  *pgxpool.Pool
	box *sqljob.SecretBox
}

type rowScanner interface {
	Scan(dest ...any) error
}

type sqlConnectionRequest struct {
	Engine                 string `json:"engine"`
	Host                   string `json:"host"`
	Port                   int    `json:"port"`
	Database               string `json:"database"`
	Username               string `json:"username"`
	Password               string `json:"password"`
	TLS                    *bool  `json:"tls_enabled"`
	TrustServerCertificate bool   `json:"trust_server_certificate"`
}

type sqlConnectionResponse struct {
	Engine                 string `json:"engine"`
	Host                   string `json:"host"`
	Port                   int    `json:"port"`
	Database               string `json:"database"`
	Username               string `json:"username"`
	PasswordConfigured     bool   `json:"password_configured"`
	TLS                    bool   `json:"tls_enabled"`
	TrustServerCertificate bool   `json:"trust_server_certificate,omitempty"`
}

type createJobRequest struct {
	Name           string                `json:"name"`
	Description    string                `json:"description"`
	ScriptType     string                `json:"script_type"`
	ScriptPath     string                `json:"script_path"`
	ScriptContent  string                `json:"script_content"`
	Args           []string              `json:"args"`
	Env            map[string]string     `json:"env"`
	WorkingDir     string                `json:"working_dir"`
	TimeoutSeconds int                   `json:"timeout_seconds"`
	Enabled        *bool                 `json:"enabled"`
	Connection     *sqlConnectionRequest `json:"connection,omitempty"`
}

type jobResponse struct {
	ID             string                 `json:"id"`
	Name           string                 `json:"name"`
	Description    string                 `json:"description"`
	ScriptType     string                 `json:"script_type"`
	ScriptPath     string                 `json:"script_path"`
	ScriptContent  string                 `json:"script_content"`
	Args           []string               `json:"args"`
	Env            map[string]string      `json:"env"`
	WorkingDir     string                 `json:"working_dir"`
	TimeoutSeconds int                    `json:"timeout_seconds"`
	Enabled        bool                   `json:"enabled"`
	Connection     *sqlConnectionResponse `json:"connection,omitempty"`
	CreatedBy      string                 `json:"created_by"`
	CreatedAt      time.Time              `json:"created_at"`
	UpdatedAt      time.Time              `json:"updated_at"`
}

// newJobsHandler creates job handlers backed by PostgreSQL and the credential encryptor.
func newJobsHandler(db *pgxpool.Pool, box *sqljob.SecretBox) *jobsHandler {
	return &jobsHandler{db: db, box: box}
}

// list returns all jobs ordered from newest to oldest.
//
// @Summary List jobs
// @Tags Jobs
// @Produce json
// @Security BearerAuth
// @Success 200 {array} jobResponse
// @Failure 401 {string} string "Authentication required"
// @Failure 500 {string} string "Database error"
// @Router /api/jobs [get]
func (h *jobsHandler) list(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.Query(r.Context(), `
		SELECT
			id::text,
			name,
			description,
			script_type,
			script_path,
			COALESCE(script_content, ''),
			args,
			env,
			working_dir,
			timeout_seconds,
			enabled,
			sql_connection,
			COALESCE(created_by::text, ''),
			created_at,
			updated_at
		FROM jobs
		ORDER BY created_at DESC
	`)
	if err != nil {
		http.Error(w, "could not list jobs", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	jobs := make([]jobResponse, 0)
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			http.Error(w, "could not read jobs", http.StatusInternalServerError)
			return
		}
		jobs = append(jobs, job)
	}

	if err := rows.Err(); err != nil {
		http.Error(w, "could not read jobs", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, jobs)
}

// create validates and stores a job created by the authenticated admin.
//
// @Summary Create a job
// @Tags Jobs
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body createJobRequest true "Job details"
// @Success 201 {object} jobResponse
// @Failure 400 {string} string "Invalid request"
// @Failure 401 {string} string "Authentication required"
// @Failure 500 {string} string "Database error"
// @Router /api/jobs [post]
func (h *jobsHandler) create(w http.ResponseWriter, r *http.Request) {
	claims, ok := r.Context().Value(authClaimsKey).(*authClaims)
	if !ok {
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return
	}

	var input createJobRequest
	if err := decodeJSON(w, r, &input); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	input.Name = strings.TrimSpace(input.Name)
	input.ScriptType = strings.ToLower(strings.TrimSpace(input.ScriptType))
	input.ScriptPath = strings.TrimSpace(input.ScriptPath)

	if input.Name == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}
	if input.ScriptPath == "" {
		http.Error(w, "script_path is required", http.StatusBadRequest)
		return
	}

	switch input.ScriptType {
	case "python", "node", "bash", "go", "custom", "sql":
	default:
		http.Error(
			w,
			"script_type must be python, node, bash, go, custom, or sql",
			http.StatusBadRequest,
		)
		return
	}

	var storedConnectionJSON []byte

	if input.ScriptType == "sql" {
		if !strings.EqualFold(filepath.Ext(input.ScriptPath), ".sql") {
			http.Error(w, "SQL jobs must use a .sql script_path", http.StatusBadRequest)
			return
		}

		if input.Connection == nil {
			http.Error(w, "connection is required for SQL jobs", http.StatusBadRequest)
			return
		}

		storedConnection, err := h.validateAndEncryptConnection(input.Connection)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		storedConnectionJSON, err = json.Marshal(storedConnection)
		if err != nil {
			http.Error(w, "could not encode SQL connection", http.StatusInternalServerError)
			return
		}
	} else if input.Connection != nil {
		http.Error(w, "connection is only valid for SQL jobs", http.StatusBadRequest)
		return
	}

	if input.TimeoutSeconds == 0 {
		input.TimeoutSeconds = 300
	}
	if input.TimeoutSeconds < 1 {
		http.Error(w, "timeout_seconds must be greater than zero", http.StatusBadRequest)
		return
	}

	if input.Args == nil {
		input.Args = []string{}
	}
	if input.Env == nil {
		input.Env = map[string]string{}
	}

	argsJSON, err := json.Marshal(input.Args)
	if err != nil {
		http.Error(w, "invalid args", http.StatusBadRequest)
		return
	}
	envJSON, err := json.Marshal(input.Env)
	if err != nil {
		http.Error(w, "invalid env", http.StatusBadRequest)
		return
	}

	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}

	job, err := scanJob(h.db.QueryRow(r.Context(), `
		INSERT INTO jobs (
			name,
			description,
			script_type,
			script_path,
			script_content,
			args,
			env,
			working_dir,
			timeout_seconds,
			enabled,
			created_by,
			sql_connection
		)
		VALUES (
			$1, $2, $3, $4, NULLIF($5, ''),
			$6::jsonb, $7::jsonb, $8, $9, $10, $11::uuid, $12::jsonb
		)
		RETURNING
			id::text,
			name,
			description,
			script_type,
			script_path,
			COALESCE(script_content, ''),
			args,
			env,
			working_dir,
			timeout_seconds,
			enabled,
			sql_connection,
			COALESCE(created_by::text, ''),
			created_at,
			updated_at
	`,
		input.Name,
		input.Description,
		input.ScriptType,
		input.ScriptPath,
		input.ScriptContent,
		string(argsJSON),
		string(envJSON),
		input.WorkingDir,
		input.TimeoutSeconds,
		enabled,
		claims.Subject,
		jsonValue(storedConnectionJSON),
	))
	if err != nil {
		http.Error(w, "could not create job", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusCreated, job)
}

// validateAndEncryptConnection validates a SQL target and encrypts its password.
func (h *jobsHandler) validateAndEncryptConnection(
	input *sqlConnectionRequest,
) (sqljob.StoredConnection, error) {
	input.Engine = strings.ToLower(strings.TrimSpace(input.Engine))
	input.Host = strings.TrimSpace(input.Host)
	input.Database = strings.TrimSpace(input.Database)
	input.Username = strings.TrimSpace(input.Username)

	switch input.Engine {
	case "postgres":
		if input.Port == 0 {
			input.Port = 5432
		}
	case "mysql":
		if input.Port == 0 {
			input.Port = 3306
		}
	case "sqlserver":
		if input.Port == 0 {
			input.Port = 1433
		}
	case "oracle":
		if input.Port == 0 {
			input.Port = 1521
		}
	default:
		return sqljob.StoredConnection{}, errors.New(
			"connection.engine must be postgres, mysql, sqlserver, or oracle",
		)
	}

	if input.Host == "" || strings.ContainsAny(input.Host, " \t\r\n/?#@") {
		return sqljob.StoredConnection{}, errors.New("connection.host is invalid")
	}
	if input.Port < 1 || input.Port > 65535 {
		return sqljob.StoredConnection{}, errors.New("connection.port must be from 1 to 65535")
	}
	if input.Database == "" {
		return sqljob.StoredConnection{}, errors.New("connection.database is required")
	}
	if input.Username == "" {
		return sqljob.StoredConnection{}, errors.New("connection.username is required")
	}
	if input.Password == "" {
		return sqljob.StoredConnection{}, errors.New("connection.password is required")
	}

	tlsEnabled := true
	if input.TLS != nil {
		tlsEnabled = *input.TLS
	}

	encryptedPassword, err := h.box.Encrypt(input.Password)
	if err != nil {
		return sqljob.StoredConnection{}, errors.New("could not secure database password")
	}

	return sqljob.StoredConnection{
		Engine:                 input.Engine,
		Host:                   input.Host,
		Port:                   input.Port,
		Database:               input.Database,
		Username:               input.Username,
		PasswordEncrypted:      encryptedPassword,
		TLS:                    tlsEnabled,
		TrustServerCertificate: input.TrustServerCertificate,
	}, nil
}

// jsonValue returns nil for an empty JSON value so PostgreSQL stores SQL NULL.
func jsonValue(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return string(value)
}

// scanJob reads a job row and decodes its JSONB fields without exposing its secret.
func scanJob(row rowScanner) (jobResponse, error) {
	var job jobResponse
	var argsJSON []byte
	var envJSON []byte
	var connectionJSON []byte

	err := row.Scan(
		&job.ID,
		&job.Name,
		&job.Description,
		&job.ScriptType,
		&job.ScriptPath,
		&job.ScriptContent,
		&argsJSON,
		&envJSON,
		&job.WorkingDir,
		&job.TimeoutSeconds,
		&job.Enabled,
		&connectionJSON,
		&job.CreatedBy,
		&job.CreatedAt,
		&job.UpdatedAt,
	)
	if err != nil {
		return jobResponse{}, err
	}

	if err := json.Unmarshal(argsJSON, &job.Args); err != nil {
		return jobResponse{}, err
	}
	if err := json.Unmarshal(envJSON, &job.Env); err != nil {
		return jobResponse{}, err
	}

	if len(connectionJSON) > 0 {
		var connection sqljob.StoredConnection
		if err := json.Unmarshal(connectionJSON, &connection); err != nil {
			return jobResponse{}, err
		}

		job.Connection = &sqlConnectionResponse{
			Engine:                 connection.Engine,
			Host:                   connection.Host,
			Port:                   connection.Port,
			Database:               connection.Database,
			Username:               connection.Username,
			PasswordConfigured:     connection.PasswordEncrypted != "",
			TLS:                    connection.TLS,
			TrustServerCertificate: connection.TrustServerCertificate,
		}
	}

	return job, nil
}

// decodeJSON decodes exactly one JSON object from a request body.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(dst); err != nil {
		return errors.New("invalid request body")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("request must contain one JSON object")
	}

	return nil
}
