package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type runHandler struct {
	db    *pgxpool.Pool
	redis *redis.Client
}

type runResponse struct {
	ID           string     `json:"id"`
	JobID        string     `json:"job_id"`
	Status       string     `json:"status"`
	TriggerType  string     `json:"trigger_type"`
	TriggeredBy  string     `json:"triggered_by,omitempty"`
	StartedAt    *time.Time `json:"started_at,omitempty"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
	ExitCode     *int       `json:"exit_code,omitempty"`
	ErrorMessage string     `json:"error_message,omitempty"`
	WorkerID     string     `json:"worker_id,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

type runLogResponse struct {
	ID        int64     `json:"id"`
	RunID     string    `json:"run_id"`
	Timestamp time.Time `json:"timestamp"`
	Stream    string    `json:"stream"`
	Message   string    `json:"message"`
}

func newRunHandler(db *pgxpool.Pool, redisClient *redis.Client) *runHandler {
	return &runHandler{db: db, redis: redisClient}
}

// @Summary Trigger a job manually
// @Tags Runs
// @Produce json
// @Security BearerAuth
// @Param id path string true "Job ID"
// @Success 202 {object} runResponse
// @Router /api/jobs/{id}/run [post]
func (h *runHandler) trigger(w http.ResponseWriter, r *http.Request) {
	claims, ok := r.Context().Value(authClaimsKey).(*authClaims)
	if !ok {
		http.Error(w, "authentication required", 401)
		return
	}
	jobID := chi.URLParam(r, "id")
	var enabled bool
	err := h.db.QueryRow(r.Context(), `SELECT enabled FROM jobs WHERE id::text = $1`, jobID).Scan(&enabled)
	if err == pgx.ErrNoRows {
		http.Error(w, "job not found", 404)
		return
	}
	if err != nil {
		http.Error(w, "could not find job", 500)
		return
	}
	if !enabled {
		http.Error(w, "job is disabled", 409)
		return
	}
	var run runResponse
	err = h.db.QueryRow(r.Context(), `INSERT INTO runs (job_id,status,trigger_type,triggered_by) VALUES ($1::uuid,'queued','manual',$2::uuid) RETURNING id::text,job_id::text,status,trigger_type,triggered_by::text,created_at`, jobID, claims.Subject).Scan(&run.ID, &run.JobID, &run.Status, &run.TriggerType, &run.TriggeredBy, &run.CreatedAt)
	if err != nil {
		http.Error(w, "could not create run", 500)
		return
	}
	if err := h.redis.LPush(r.Context(), "job_queue", run.ID).Err(); err != nil {
		_, updateErr := h.db.Exec(r.Context(), `UPDATE runs SET status='failed',error_message='could not enqueue run',finished_at=now() WHERE id=$1::uuid`, run.ID)
		if updateErr != nil {
			log.Printf("mark run %s failed after Redis error: %v", run.ID, updateErr)
		}
		http.Error(w, "could not queue run", 503)
		return
	}
	writeJSON(w, http.StatusAccepted, run)
}

// @Summary List job runs
// @Tags Runs
// @Produce json
// @Security BearerAuth
// @Param id path string true "Job ID"
// @Router /api/jobs/{id}/runs [get]
func (h *runHandler) list(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.Query(r.Context(), `SELECT id::text,job_id::text,status,trigger_type,COALESCE(triggered_by::text,''),started_at,finished_at,exit_code,COALESCE(error_message,''),COALESCE(worker_id,''),created_at FROM runs WHERE job_id::text=$1 ORDER BY created_at DESC LIMIT 500`, chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "could not list runs", 500)
		return
	}
	defer rows.Close()
	runs := make([]runResponse, 0)
	for rows.Next() {
		var run runResponse
		if err := rows.Scan(&run.ID, &run.JobID, &run.Status, &run.TriggerType, &run.TriggeredBy, &run.StartedAt, &run.FinishedAt, &run.ExitCode, &run.ErrorMessage, &run.WorkerID, &run.CreatedAt); err != nil {
			http.Error(w, "could not read runs", 500)
			return
		}
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, "could not read runs", 500)
		return
	}
	writeJSON(w, 200, runs)
}

// @Summary Get a run
// @Tags Runs
// @Produce json
// @Security BearerAuth
// @Param id path string true "Run ID"
// @Router /api/runs/{id} [get]
func (h *runHandler) get(w http.ResponseWriter, r *http.Request) {
	run, err := h.findRun(r, chi.URLParam(r, "id"))
	if err == pgx.ErrNoRows {
		http.Error(w, "run not found", 404)
		return
	}
	if err != nil {
		http.Error(w, "could not find run", 500)
		return
	}
	writeJSON(w, 200, run)
}

func (h *runHandler) findRun(r *http.Request, id string) (runResponse, error) {
	var run runResponse
	err := h.db.QueryRow(r.Context(), `SELECT id::text,job_id::text,status,trigger_type,COALESCE(triggered_by::text,''),started_at,finished_at,exit_code,COALESCE(error_message,''),COALESCE(worker_id,''),created_at FROM runs WHERE id::text=$1`, id).Scan(&run.ID, &run.JobID, &run.Status, &run.TriggerType, &run.TriggeredBy, &run.StartedAt, &run.FinishedAt, &run.ExitCode, &run.ErrorMessage, &run.WorkerID, &run.CreatedAt)
	return run, err
}

// @Summary Get run logs
// @Tags Runs
// @Produce json
// @Security BearerAuth
// @Param id path string true "Run ID"
// @Param after query int false "Return logs after this ID"
// @Param limit query int false "Maximum logs to return"
// @Router /api/runs/{id}/logs [get]
func (h *runHandler) logs(w http.ResponseWriter, r *http.Request) {
	after, limit, err := logQueryParams(r)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	id := chi.URLParam(r, "id")
	if _, err := h.findRun(r, id); err == pgx.ErrNoRows {
		http.Error(w, "run not found", 404)
		return
	} else if err != nil {
		http.Error(w, "could not find run", 500)
		return
	}
	entries, err := h.readLogs(r, id, after, limit)
	if err != nil {
		http.Error(w, "could not read logs", 500)
		return
	}
	writeJSON(w, 200, entries)
}

func logQueryParams(r *http.Request) (int64, int, error) {
	after, limit := int64(0), 200
	var err error
	if v := r.URL.Query().Get("after"); v != "" {
		after, err = strconv.ParseInt(v, 10, 64)
		if err != nil || after < 0 {
			return 0, 0, &httpError{"after must be a non-negative integer"}
		}
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		limit, err = strconv.Atoi(v)
		if err != nil || limit < 1 || limit > 1000 {
			return 0, 0, &httpError{"limit must be between 1 and 1000"}
		}
	}
	return after, limit, nil
}

type httpError struct{ message string }

func (e *httpError) Error() string { return e.message }

func (h *runHandler) readLogs(r *http.Request, id string, after int64, limit int) ([]runLogResponse, error) {
	rows, err := h.db.Query(r.Context(), `SELECT id,run_id::text,timestamp,stream,message FROM run_logs WHERE run_id::text=$1 AND id>$2 ORDER BY id ASC LIMIT $3`, id, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := make([]runLogResponse, 0)
	for rows.Next() {
		var e runLogResponse
		if err := rows.Scan(&e.ID, &e.RunID, &e.Timestamp, &e.Stream, &e.Message); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// @Summary Stream run logs
// @Tags Runs
// @Produce text/event-stream
// @Security BearerAuth
// @Param id path string true "Run ID"
// @Router /api/runs/{id}/logs/stream [get]
func (h *runHandler) stream(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := h.findRun(r, id); err == pgx.ErrNoRows {
		http.Error(w, "run not found", 404)
		return
	} else if err != nil {
		http.Error(w, "could not find run", 500)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming is not supported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher.Flush()
	after, limit, err := logQueryParams(r)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		entries, err := h.readLogs(r, id, after, limit)
		if err != nil {
			return
		}
		for _, entry := range entries {
			payload, _ := json.Marshal(entry)
			_, _ = w.Write([]byte("id: " + strconv.FormatInt(entry.ID, 10) + "\ndata: " + string(payload) + "\n\n"))
			after = entry.ID
		}
		if len(entries) > 0 {
			flusher.Flush()
		}
		run, err := h.findRun(r, id)
		if err != nil {
			return
		}
		if isTerminalRunStatus(run.Status) {
			_, _ = w.Write([]byte("event: done\ndata: " + strconv.Quote(run.Status) + "\n\n"))
			flusher.Flush()
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}
func isTerminalRunStatus(status string) bool {
	return status == "success" || status == "failed" || status == "timeout" || status == "canceled"
}
