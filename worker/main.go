package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"job_scheduler/internal/dockerexec"
	"job_scheduler/internal/sqljob"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const queueName = "job_queue"

type job struct {
	ScriptType     string
	ScriptPath     string
	ArgsJSON       []byte
	EnvJSON        []byte
	SQLConnection  []byte
	WorkingDir     string
	TimeoutSeconds int
}

// main connects to PostgreSQL and Redis, then processes queued runs until shutdown.
func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	credentialBox, err := sqljob.NewSecretBoxFromEnv()
	if err != nil {
		log.Fatalf("load SQL credential encryption key: %v", err)
	}

	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "redis:6379"
	}

	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelStartup()

	db, err := pgxpool.New(startupCtx, databaseURL)
	if err != nil {
		log.Fatalf("create database pool: %v", err)
	}
	defer db.Close()

	if err := db.Ping(startupCtx); err != nil {
		log.Fatalf("connect to PostgreSQL: %v", err)
	}

	redisClient := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer redisClient.Close()

	if err := redisClient.Ping(startupCtx).Err(); err != nil {
		log.Fatalf("connect to Redis: %v", err)
	}

	dockerExecutor, err := dockerexec.NewFromEnv()
	if err != nil {
		log.Fatalf("configure Docker executor: %v", err)
	}
	defer dockerExecutor.Close()

	workerID, err := os.Hostname()
	if err != nil {
		workerID = "worker"
	}

	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()

	log.Printf("worker %s started", workerID)
	if err := workLoop(ctx, db, redisClient, workerID, credentialBox, dockerExecutor); err != nil {
		log.Printf("worker stopped: %v", err)
	}
}

// workLoop waits for run IDs and processes them one at a time.
func workLoop(
	ctx context.Context,
	db *pgxpool.Pool,
	redisClient *redis.Client,
	workerID string,
	credentialBox *sqljob.SecretBox,
	dockerExecutor *dockerexec.Executor,
) error {
	for {
		item, err := redisClient.BRPop(ctx, 0, queueName).Result()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}

			log.Printf("Redis queue error: %v", err)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(2 * time.Second):
				continue
			}
		}

		if len(item) != 2 {
			log.Printf("unexpected Redis queue response: %#v", item)
			continue
		}

		if err := processRun(ctx, db, item[1], workerID, credentialBox, dockerExecutor); err != nil {
			log.Printf("process run %s: %v", item[1], err)
		}
	}
}

// processRun claims a queued run, executes its script, and stores its result.
func processRun(
	ctx context.Context,
	db *pgxpool.Pool,
	runID string,
	workerID string,
	credentialBox *sqljob.SecretBox,
	dockerExecutor *dockerexec.Executor,
) error {
	var currentJob job

	err := db.QueryRow(ctx, `
		WITH claimed AS (
			UPDATE runs
			SET status = 'running',
			    started_at = now(),
			    worker_id = $2
			WHERE id = $1::uuid AND status = 'queued'
			RETURNING job_id
		)
		SELECT
			j.script_type,
			j.script_path,
			j.args,
			j.env,
			j.sql_connection,
			j.working_dir,
			j.timeout_seconds
		FROM claimed
		JOIN jobs AS j ON j.id = claimed.job_id
	`, runID, workerID).Scan(
		&currentJob.ScriptType,
		&currentJob.ScriptPath,
		&currentJob.ArgsJSON,
		&currentJob.EnvJSON,
		&currentJob.SQLConnection,
		&currentJob.WorkingDir,
		&currentJob.TimeoutSeconds,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	scriptPath, err := pathUnderScripts(currentJob.ScriptPath, false)
	if err != nil {
		return finishRun(db, runID, "failed", nil, err.Error(), nil, nil)
	}

	if currentJob.ScriptType == "sql" &&
		!strings.EqualFold(filepath.Ext(scriptPath), ".sql") {
		return finishRun(db, runID, "failed", nil, "SQL jobs must use a .sql file", nil, nil)
	}

	workingDir := currentJob.WorkingDir
	if workingDir == "" {
		workingDir = "/scripts"
	}

	workingDir, err = pathUnderScripts(workingDir, true)
	if err != nil {
		return finishRun(db, runID, "failed", nil, err.Error(), nil, nil)
	}

	var args []string
	if err := json.Unmarshal(currentJob.ArgsJSON, &args); err != nil {
		return finishRun(db, runID, "failed", nil, "invalid job arguments", nil, nil)
	}

	env := make(map[string]string)
	if err := json.Unmarshal(currentJob.EnvJSON, &env); err != nil {
		return finishRun(db, runID, "failed", nil, "invalid job environment", nil, nil)
	}

	if currentJob.TimeoutSeconds < 1 {
		return finishRun(db, runID, "failed", nil, "invalid job timeout", nil, nil)
	}

	runCtx, cancel := context.WithTimeout(
		ctx,
		time.Duration(currentJob.TimeoutSeconds)*time.Second,
	)

	var stdout []byte
	var stderr []byte
	var runErr error
	var exitCode any = 0

	if currentJob.ScriptType == "sql" {
		stdoutWriter := &runLogWriter{db: db, runID: runID, stream: "stdout"}
		stderrWriter := &runLogWriter{db: db, runID: runID, stream: "stderr"}
		result := dockerExecutor.RunSQL(
			runCtx,
			runID,
			scriptPath,
			currentJob.SQLConnection,
			os.Getenv("SQL_CREDENTIALS_KEY"),
			stdoutWriter,
			stderrWriter,
		)
		runErr = result.Err
		exitCode = result.ExitCode
		if err := stdoutWriter.Flush(); err != nil {
			log.Printf("save stdout for run %s: %v", runID, err)
		}
		if err := stderrWriter.Flush(); err != nil {
			log.Printf("save stderr for run %s: %v", runID, err)
		}
	} else {
		stdoutWriter := &runLogWriter{db: db, runID: runID, stream: "stdout"}
		stderrWriter := &runLogWriter{db: db, runID: runID, stream: "stderr"}
		result := dockerExecutor.Run(
			runCtx,
			runID,
			currentJob.ScriptType,
			scriptPath,
			args,
			mergedEnvironment(env),
			workingDir,
			stdoutWriter,
			stderrWriter,
		)
		runErr = result.Err
		exitCode = result.ExitCode
		if err := stdoutWriter.Flush(); err != nil {
			log.Printf("save stdout for run %s: %v", runID, err)
		}
		if err := stderrWriter.Flush(); err != nil {
			log.Printf("save stderr for run %s: %v", runID, err)
		}
	}

	contextErr := runCtx.Err()
	cancel()

	status := "success"
	errorMessage := ""

	if runErr != nil {
		status = "failed"
		errorMessage = runErr.Error()

		if errors.Is(contextErr, context.DeadlineExceeded) {
			status = "timeout"
		} else if errors.Is(contextErr, context.Canceled) {
			status = "canceled"
		}
	}

	if err := finishRun(
		db,
		runID,
		status,
		exitCode,
		errorMessage,
		stdout,
		stderr,
	); err != nil {
		return err
	}

	log.Printf("run %s finished: status=%s", runID, status)
	return nil
}

// runLogWriter persists complete output lines while a process is running.
// This lets API clients observe logs before the command exits.
type runLogWriter struct {
	db     *pgxpool.Pool
	runID  string
	stream string
	buffer bytes.Buffer
}

func (w *runLogWriter) Write(data []byte) (int, error) {
	if _, err := w.buffer.Write(data); err != nil {
		return 0, err
	}
	for {
		line, err := w.buffer.ReadString('\n')
		if err != nil {
			w.buffer.WriteString(line)
			break
		}
		if err := w.save(strings.TrimSuffix(line, "\n")); err != nil {
			return len(data), err
		}
	}
	return len(data), nil
}

func (w *runLogWriter) Flush() error {
	if w.buffer.Len() == 0 {
		return nil
	}
	line := w.buffer.String()
	w.buffer.Reset()
	return w.save(line)
}

func (w *runLogWriter) save(message string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := w.db.Exec(ctx, `
		INSERT INTO run_logs (run_id, stream, message)
		VALUES ($1::uuid, $2, $3)
	`, w.runID, w.stream, message)
	return err
}

// executeSQL connects to the configured database and runs the SQL file.
func executeSQL(
	ctx context.Context,
	scriptPath string,
	connectionJSON []byte,
	credentialBox *sqljob.SecretBox,
) ([]byte, []byte, error) {
	var connection sqljob.StoredConnection
	if len(connectionJSON) == 0 {
		return nil, []byte("SQL connection is missing"), errors.New("SQL connection is missing")
	}
	if err := json.Unmarshal(connectionJSON, &connection); err != nil {
		return nil, []byte("SQL connection configuration is invalid"), errors.New(
			"SQL connection configuration is invalid",
		)
	}

	password, err := credentialBox.Decrypt(connection.PasswordEncrypted)
	if err != nil {
		return nil, []byte(err.Error()), err
	}

	script, err := os.ReadFile(scriptPath)
	if err != nil {
		return nil, []byte("could not read SQL script"), errors.New("could not read SQL script")
	}
	if strings.TrimSpace(string(script)) == "" {
		return nil, []byte("SQL script is empty"), errors.New("SQL script is empty")
	}

	targetDB, err := connection.OpenDB(ctx, password)
	if err != nil {
		message := redactPassword(err.Error(), password)
		return nil, []byte(message), errors.New(message)
	}
	defer targetDB.Close()

	result, err := targetDB.ExecContext(ctx, string(script))
	if err != nil {
		message := redactPassword(err.Error(), password)
		return nil, []byte(message), errors.New(message)
	}

	var output bytes.Buffer
	if rowsAffected, err := result.RowsAffected(); err == nil {
		_, _ = fmt.Fprintf(&output, "SQL script completed; rows affected: %d\n", rowsAffected)
	} else {
		_, _ = output.WriteString("SQL script completed\n")
	}

	return output.Bytes(), nil, nil
}

// redactPassword removes a plaintext password from a driver error before saving it.
func redactPassword(message, password string) string {
	if password == "" {
		return message
	}
	return strings.ReplaceAll(message, password, "[REDACTED]")
}

// pathUnderScripts checks that a script or working directory stays inside /scripts.
func pathUnderScripts(value string, requireDirectory bool) (string, error) {
	const root = "/scripts"

	if value == "" {
		return "", errors.New("script path is required")
	}

	cleaned := filepath.Clean(value)
	if !filepath.IsAbs(cleaned) {
		cleaned = filepath.Join(root, cleaned)
	}

	relative, err := filepath.Rel(root, cleaned)
	if err != nil || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return "", errors.New("script paths must stay inside /scripts")
	}

	resolved, err := filepath.EvalSymlinks(cleaned)
	if err != nil {
		return "", fmt.Errorf("script path unavailable: %w", err)
	}

	resolvedRelative, err := filepath.Rel(root, resolved)
	if err != nil || resolvedRelative == ".." ||
		strings.HasPrefix(resolvedRelative, ".."+string(os.PathSeparator)) {
		return "", errors.New("script paths must stay inside /scripts")
	}

	info, err := os.Stat(resolved)
	if err != nil {
		return "", fmt.Errorf("script path unavailable: %w", err)
	}
	if requireDirectory && !info.IsDir() {
		return "", errors.New("working_dir must be a directory")
	}
	if !requireDirectory && !info.Mode().IsRegular() {
		return "", errors.New("script_path must point to a regular file")
	}

	return resolved, nil
}

// mergedEnvironment combines the worker environment with the job environment.
func mergedEnvironment(extra map[string]string) []string {
	values := make(map[string]string)

	for _, item := range os.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			values[key] = value
		}
	}
	for key, value := range extra {
		values[key] = value
	}

	result := make([]string, 0, len(values))
	for key, value := range values {
		result = append(result, key+"="+value)
	}
	sort.Strings(result)

	return result
}

// finishRun stores captured output and updates the run's final status.
func finishRun(
	db *pgxpool.Pool,
	runID string,
	status string,
	exitCode any,
	errorMessage string,
	stdout []byte,
	stderr []byte,
) error {
	saveCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if len(stdout) > 0 {
		if _, err := db.Exec(saveCtx, `
			INSERT INTO run_logs (run_id, stream, message)
			VALUES ($1::uuid, 'stdout', $2)
		`, runID, string(stdout)); err != nil {
			log.Printf("save stdout for run %s: %v", runID, err)
		}
	}

	if len(stderr) > 0 {
		if _, err := db.Exec(saveCtx, `
			INSERT INTO run_logs (run_id, stream, message)
			VALUES ($1::uuid, 'stderr', $2)
		`, runID, string(stderr)); err != nil {
			log.Printf("save stderr for run %s: %v", runID, err)
		}
	}

	_, err := db.Exec(saveCtx, `
		UPDATE runs
		SET status = $2,
		    exit_code = $3,
		    error_message = NULLIF($4, ''),
		    finished_at = now()
		WHERE id = $1::uuid
	`, runID, status, exitCode, errorMessage)

	return err
}
