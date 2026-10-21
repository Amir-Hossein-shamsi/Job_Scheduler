package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/robfig/cron/v3"
)

const (
	queueName       = "job_queue"
	pollInterval    = 5 * time.Second
	claimBatchLimit = 100
)

type dueSchedule struct {
	ID              string
	JobID           string
	Type            string
	RunAt           *time.Time
	CronExpression  *string
	IntervalSeconds *int
	Timezone        string
	NextRunAt       time.Time
}

func main() {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	redisAddr := strings.TrimSpace(os.Getenv("REDIS_ADDR"))
	if redisAddr == "" {
		redisAddr = "redis:6379"
	}

	startupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	db, err := pgxpool.New(startupCtx, databaseURL)
	if err != nil {
		cancel()
		log.Fatalf("create database pool: %v", err)
	}
	if err := db.Ping(startupCtx); err != nil {
		cancel()
		db.Close()
		log.Fatalf("connect to PostgreSQL: %v", err)
	}
	cancel()
	defer db.Close()

	redisClient := redis.NewClient(&redis.Options{Addr: redisAddr})
	startupCtx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	if err := redisClient.Ping(startupCtx).Err(); err != nil {
		cancel()
		_ = redisClient.Close()
		log.Fatalf("connect to Redis: %v", err)
	}
	cancel()
	defer redisClient.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("scheduler started; polling every %s", pollInterval)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		if err := processDue(ctx, db, redisClient); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("process due schedules: %v", err)
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

type scheduleDatabase interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type scheduleQueue interface {
	LPush(context.Context, string, ...any) *redis.IntCmd
}

func processDue(ctx context.Context, db scheduleDatabase, redisClient scheduleQueue) error {
	tx, err := db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	now := time.Now().UTC()
	rows, err := tx.Query(ctx, `
		SELECT
			s.id::text,
			s.job_id::text,
			s.type,
			s.run_at,
			s.cron_expr,
			s.interval_seconds,
			s.timezone,
			s.next_run_at
		FROM schedules AS s
		JOIN jobs AS j ON j.id = s.job_id
		WHERE s.enabled = TRUE
		  AND j.enabled = TRUE
		  AND s.next_run_at IS NOT NULL
		  AND s.next_run_at <= $1
		ORDER BY s.next_run_at ASC
		FOR UPDATE OF s SKIP LOCKED
		LIMIT $2
	`, now, claimBatchLimit)
	if err != nil {
		return err
	}
	defer rows.Close()

	// Read and close the result set before issuing another query on this
	// transaction's connection. Row locks remain held until commit.
	due := make([]dueSchedule, 0)
	for rows.Next() {
		var schedule dueSchedule
		if err := rows.Scan(
			&schedule.ID,
			&schedule.JobID,
			&schedule.Type,
			&schedule.RunAt,
			&schedule.CronExpression,
			&schedule.IntervalSeconds,
			&schedule.Timezone,
			&schedule.NextRunAt,
		); err != nil {
			return err
		}
		due = append(due, schedule)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()

	queuedRunIDs := make([]string, 0, len(due))
	for _, schedule := range due {
		nextRunAt, enabled, err := nextScheduleState(schedule, now)
		if err != nil {
			log.Printf("disable invalid schedule %s: %v", schedule.ID, err)
			if _, updateErr := tx.Exec(ctx, `
				UPDATE schedules
				SET enabled = FALSE, next_run_at = NULL
				WHERE id = $1::uuid
			`, schedule.ID); updateErr != nil {
				return updateErr
			}
			continue
		}

		var runID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO runs (job_id, status, trigger_type)
			VALUES ($1::uuid, 'queued', 'schedule')
			RETURNING id::text
		`, schedule.JobID).Scan(&runID); err != nil {
			return err
		}

		if _, err := tx.Exec(ctx, `
			UPDATE schedules
			SET enabled = $2,
			    next_run_at = $3
			WHERE id = $1::uuid
		`, schedule.ID, enabled, nextRunAt); err != nil {
			return err
		}
		queuedRunIDs = append(queuedRunIDs, runID)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	for _, runID := range queuedRunIDs {
		if err := redisClient.LPush(ctx, queueName, runID).Err(); err != nil {
			log.Printf("enqueue scheduled run %s: %v", runID, err)
			_, updateErr := db.Exec(ctx, `
				UPDATE runs
				SET status = 'failed', error_message = 'could not enqueue scheduled run', finished_at = now()
				WHERE id = $1::uuid AND status = 'queued'
			`, runID)
			if updateErr != nil {
				log.Printf("mark scheduled run %s failed: %v", runID, updateErr)
			}
		}
	}

	return nil
}

func nextScheduleState(schedule dueSchedule, now time.Time) (*time.Time, bool, error) {
	switch schedule.Type {
	case "once":
		return nil, false, nil
	case "interval":
		if schedule.IntervalSeconds == nil || *schedule.IntervalSeconds < 1 {
			return nil, false, fmt.Errorf("interval_seconds must be positive")
		}
		next := now.Add(time.Duration(*schedule.IntervalSeconds) * time.Second)
		return &next, true, nil
	case "cron":
		if schedule.CronExpression == nil || strings.TrimSpace(*schedule.CronExpression) == "" {
			return nil, false, errors.New("cron expression is required")
		}
		location, err := time.LoadLocation(schedule.Timezone)
		if err != nil {
			return nil, false, fmt.Errorf("invalid timezone %q: %w", schedule.Timezone, err)
		}
		parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
		spec, err := parser.Parse(*schedule.CronExpression)
		if err != nil {
			return nil, false, fmt.Errorf("invalid cron expression: %w", err)
		}
		next := spec.Next(now.In(location)).UTC()
		return &next, true, nil
	default:
		return nil, false, fmt.Errorf("unsupported schedule type %q", schedule.Type)
	}
}
