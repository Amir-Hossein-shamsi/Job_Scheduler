-- migrations/001_init.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    username      Text NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    script_type     TEXT NOT NULL,
    script_path     TEXT NOT NULL,
    script_content  TEXT,
    args            JSONB NOT NULL DEFAULT '[]'::jsonb,
    env             JSONB NOT NULL DEFAULT '{}'::jsonb,
    working_dir     TEXT NOT NULL DEFAULT '',
    timeout_seconds INT NOT NULL DEFAULT 300 CHECK (timeout_seconds > 0),
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE schedules (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id           UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    type             TEXT NOT NULL CHECK (type IN ('once', 'cron', 'interval')),
    run_at           TIMESTAMPTZ,
    cron_expr        TEXT,
    interval_seconds INT,
    timezone         TEXT NOT NULL DEFAULT 'UTC',
    next_run_at      TIMESTAMPTZ,
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (
        (type = 'once' AND run_at IS NOT NULL)
        OR (type = 'cron' AND cron_expr IS NOT NULL)
        OR (type = 'interval' AND interval_seconds > 0)
    )
);

CREATE INDEX schedules_due_idx
    ON schedules (next_run_at)
    WHERE enabled = TRUE;

CREATE TABLE runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'success', 'failed', 'timeout', 'canceled')),
    trigger_type  TEXT NOT NULL CHECK (trigger_type IN ('manual', 'schedule')),
    triggered_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    exit_code     INT,
    error_message TEXT,
    worker_id     TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX runs_job_created_idx
    ON runs (job_id, created_at DESC);

CREATE TABLE run_logs (
    id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id    UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    stream    TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr')),
    message   TEXT NOT NULL
);

CREATE INDEX run_logs_run_id_id_idx
    ON run_logs (run_id, id);
