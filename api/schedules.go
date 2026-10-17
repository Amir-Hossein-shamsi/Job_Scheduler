package main

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/robfig/cron/v3"
)

type scheduleHandler struct {
	db *pgxpool.Pool
}

type scheduleRequest struct {
	Type            string     `json:"type"`
	RunAt           *time.Time `json:"run_at"`
	CronExpression  string     `json:"cron_expr"`
	IntervalSeconds int        `json:"interval_seconds"`
	Timezone        string     `json:"timezone"`
	Enabled         *bool      `json:"enabled"`
}

type scheduleResponse struct {
	ID              string     `json:"id"`
	JobID           string     `json:"job_id"`
	Type            string     `json:"type"`
	RunAt           *time.Time `json:"run_at,omitempty"`
	CronExpression  string     `json:"cron_expr,omitempty"`
	IntervalSeconds *int       `json:"interval_seconds,omitempty"`
	Timezone        string     `json:"timezone"`
	NextRunAt       *time.Time `json:"next_run_at,omitempty"`
	Enabled         bool       `json:"enabled"`
	CreatedAt       time.Time  `json:"created_at"`
}

func newScheduleHandler(db *pgxpool.Pool) *scheduleHandler {
	return &scheduleHandler{db: db}
}

// @Summary List schedules for a job
// @Tags Schedules
// @Produce json
// @Security BearerAuth
// @Param id path string true "Job ID"
// @Success 200 {array} scheduleResponse
// @Failure 401 {string} string "Authentication required"
// @Router /api/jobs/{id}/schedules [get]
func (h *scheduleHandler) list(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.Query(r.Context(), `
		SELECT id::text, job_id::text, type, run_at, COALESCE(cron_expr, ''),
		       interval_seconds, timezone, next_run_at, enabled, created_at
		FROM schedules
		WHERE job_id::text = $1
		ORDER BY created_at DESC
	`, chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "could not list schedules", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	items := make([]scheduleResponse, 0)
	for rows.Next() {
		item, err := scanSchedule(rows)
		if err != nil {
			http.Error(w, "could not read schedules", http.StatusInternalServerError)
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, "could not read schedules", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// @Summary Create a schedule
// @Tags Schedules
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path string true "Job ID"
// @Param request body scheduleRequest true "Schedule details"
// @Success 201 {object} scheduleResponse
// @Failure 400 {string} string "Invalid schedule"
// @Failure 401 {string} string "Authentication required"
// @Router /api/jobs/{id}/schedules [post]
func (h *scheduleHandler) create(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "id")
	var exists bool
	if err := h.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM jobs WHERE id::text = $1)`, jobID).Scan(&exists); err != nil {
		http.Error(w, "could not find job", http.StatusInternalServerError)
		return
	}
	if !exists {
		http.Error(w, "job not found", http.StatusNotFound)
		return
	}

	var input scheduleRequest
	if err := decodeJSON(w, r, &input); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	values, err := normalizeSchedule(input, time.Now())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	item, err := scanSchedule(h.db.QueryRow(r.Context(), `
		INSERT INTO schedules (
			job_id, type, run_at, cron_expr, interval_seconds,
			timezone, next_run_at, enabled
		)
		VALUES ($1::uuid, $2, $3, NULLIF($4, ''), $5, $6, $7, $8)
		RETURNING id::text, job_id::text, type, run_at, COALESCE(cron_expr, ''),
		          interval_seconds, timezone, next_run_at, enabled, created_at
	`, jobID, values.scheduleType, values.runAt, values.cronExpr,
		values.intervalSeconds, values.timezone, values.nextRunAt, values.enabled))
	if err != nil {
		http.Error(w, "could not create schedule", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

// @Summary Update a schedule
// @Tags Schedules
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path string true "Schedule ID"
// @Param request body scheduleRequest true "Schedule details"
// @Success 200 {object} scheduleResponse
// @Failure 400 {string} string "Invalid schedule"
// @Failure 401 {string} string "Authentication required"
// @Failure 404 {string} string "Schedule not found"
// @Router /api/schedules/{id} [patch]
func (h *scheduleHandler) update(w http.ResponseWriter, r *http.Request) {
	var input scheduleRequest
	if err := decodeJSON(w, r, &input); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	values, err := normalizeSchedule(input, time.Now())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	item, err := scanSchedule(h.db.QueryRow(r.Context(), `
		UPDATE schedules
		SET type = $2,
		    run_at = $3,
		    cron_expr = NULLIF($4, ''),
		    interval_seconds = $5,
		    timezone = $6,
		    next_run_at = $7,
		    enabled = $8
		WHERE id::text = $1
		RETURNING id::text, job_id::text, type, run_at, COALESCE(cron_expr, ''),
		          interval_seconds, timezone, next_run_at, enabled, created_at
	`, chi.URLParam(r, "id"), values.scheduleType, values.runAt, values.cronExpr,
		values.intervalSeconds, values.timezone, values.nextRunAt, values.enabled))
	if errors.Is(err, pgx.ErrNoRows) {
		http.Error(w, "schedule not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "could not update schedule", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// @Summary Delete a schedule
// @Tags Schedules
// @Security BearerAuth
// @Param id path string true "Schedule ID"
// @Success 204
// @Failure 401 {string} string "Authentication required"
// @Failure 404 {string} string "Schedule not found"
// @Router /api/schedules/{id} [delete]
func (h *scheduleHandler) delete(w http.ResponseWriter, r *http.Request) {
	result, err := h.db.Exec(r.Context(), `DELETE FROM schedules WHERE id::text = $1`, chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "could not delete schedule", http.StatusInternalServerError)
		return
	}
	if result.RowsAffected() == 0 {
		http.Error(w, "schedule not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type normalizedSchedule struct {
	scheduleType    string
	runAt           *time.Time
	cronExpr        string
	intervalSeconds *int
	timezone        string
	nextRunAt       *time.Time
	enabled         bool
}

func normalizeSchedule(input scheduleRequest, now time.Time) (normalizedSchedule, error) {
	result := normalizedSchedule{
		scheduleType: strings.ToLower(strings.TrimSpace(input.Type)),
		cronExpr:     strings.TrimSpace(input.CronExpression),
		timezone:     strings.TrimSpace(input.Timezone),
		enabled:      true,
	}
	if input.Enabled != nil {
		result.enabled = *input.Enabled
	}
	if result.timezone == "" {
		result.timezone = "UTC"
	}
	location, err := time.LoadLocation(result.timezone)
	if err != nil {
		return normalizedSchedule{}, errors.New("timezone is invalid")
	}

	switch result.scheduleType {
	case "once":
		if input.RunAt == nil {
			return normalizedSchedule{}, errors.New("run_at is required for once schedules")
		}
		result.runAt = input.RunAt
		result.nextRunAt = input.RunAt
	case "interval":
		if input.IntervalSeconds < 1 {
			return normalizedSchedule{}, errors.New("interval_seconds must be greater than zero")
		}
		result.intervalSeconds = &input.IntervalSeconds
		next := now.Add(time.Duration(input.IntervalSeconds) * time.Second)
		result.nextRunAt = &next
	case "cron":
		if result.cronExpr == "" {
			return normalizedSchedule{}, errors.New("cron_expr is required for cron schedules")
		}
		parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
		spec, err := parser.Parse(result.cronExpr)
		if err != nil {
			return normalizedSchedule{}, errors.New("cron_expr is invalid")
		}
		next := spec.Next(now.In(location)).UTC()
		result.nextRunAt = &next
	default:
		return normalizedSchedule{}, errors.New("type must be once, cron, or interval")
	}

	return result, nil
}

func scanSchedule(row rowScanner) (scheduleResponse, error) {
	var item scheduleResponse
	err := row.Scan(
		&item.ID,
		&item.JobID,
		&item.Type,
		&item.RunAt,
		&item.CronExpression,
		&item.IntervalSeconds,
		&item.Timezone,
		&item.NextRunAt,
		&item.Enabled,
		&item.CreatedAt,
	)
	return item, err
}
