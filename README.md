# Job Scheduler

An admin-only job scheduler that runs Python, Node, Bash (or any) scripts
on a specific date/time or recurring schedule, and shows run status and logs.

Built with Next.js, Go (chi), PostgreSQL, Redis, and Docker Compose.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Data Model](#data-model)
- [Environment Variables](#environment-variables)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [API Reference](#api-reference)
- [How It Works](#how-it-works)
- [Script Types](#script-types)
- [Scheduling](#scheduling)
- [Logs](#logs)
- [Roadmap](#roadmap)
- [Security Notes](#security-notes)

---

## Features

### MVP

- Admin login (JWT)
- Create / edit / delete jobs
- Choose script type: `python`, `node`, `bash`, `go`, `custom`
- Set script path, arguments, environment variables, working directory
- Set timeout
- Schedule:
  - **Once** — run at a specific date and time
  - **Cron** — recurring expression
  - **Interval** — every N seconds / minutes / hours
- Manual trigger
- Run history with status: `queued`, `running`, `success`, `failed`, `timeout`, `canceled`
- Live logs via SSE (Server-Sent Events)
- Cancel a running job

### Later

- Docker-per-run isolation with CPU/memory limits
- File upload for scripts
- Artifacts storage
- Email / Slack notifications
- Multi-admin with roles
- Kafka event stream
- gRPC worker control
- Retry policies and concurrency limits

---

## Architecture

```
┌──────────────────────┐
│  Next.js (admin UI)  │
└──────────┬───────────┘
           │ REST + SSE
           ▼
┌──────────────────────┐        ┌──────────────┐
│   Go API (chi)       │◄──────►│ PostgreSQL   │
│   - auth             │        │ jobs         │
│   - jobs CRUD        │        │ schedules    │
│   - runs             │        │ runs         │
│   - SSE logs         │        │ run_logs     │
└──────────┬───────────┘        └──────┬───────┘
           │                           │
           │                           │
           ▼                           ▼
┌──────────────────────┐        ┌──────────────┐
│   Redis              │        │  Scheduler   │
│   - queue            │◄──────►│  (Go)        │
│   - pub/sub          │        │  creates runs│
│   - locks            │        └──────────────┘
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Worker (Go)        │
│   - pops queue       │
│   - executes script  │
│   - streams logs     │
└──────────────────────┘
```

**Services:**

| Service     | Role |
|-------------|------|
| `web`       | Next.js admin dashboard |
| `api`       | Go + chi REST API and SSE |
| `scheduler` | Go loop that creates runs when schedules are due |
| `worker`    | Go process that executes scripts |
| `postgres`  | Persistent storage |
| `redis`     | Queue, pub/sub for logs, locks |

---

## Tech Stack

**Backend**

- Go 1.26+
- chi router
- pgx (PostgreSQL driver)
- go-redis
- robfig/cron (cron parsing)
- golang-jwt (auth)

**Frontend**

- Next.js 16 (App Router)
- TypeScript
- Tailwind CSS
- shadcn/ui (optional)
- SWR or React Query for data fetching

**Infra**

- PostgreSQL 16
- Redis 7
- Docker + Docker Compose

---

## Project Structure

```
job-scheduler/
├── api/                      # Go REST API
│   ├── main.go
│   ├── handlers/
│   │   ├── auth.go
│   │   ├── jobs.go
│   │   ├── schedules.go
│   │   ├── runs.go
│   │   └── logs.go           # SSE
│   ├── middleware/
│   │   ├── auth.go           # JWT + admin check
│   │   └── logging.go
│   ├── db/
│   │   ├── pool.go
│   │   └── queries/
│   ├── models/
│   └── Dockerfile
│
├── scheduler/                # Go scheduler loop
│   ├── main.go
│   ├── cron.go
│   └── Dockerfile
│
├── worker/                   # Go worker executor
│   ├── main.go
│   ├── executor/
│   │   ├── python.go
│   │   ├── node.go
│   │   ├── bash.go
│   │   └── runner.go
│   └── Dockerfile
│
├── web/                      # Next.js frontend
│   ├── app/
│   │   ├── login/page.tsx
│   │   ├── jobs/page.tsx
│   │   ├── jobs/new/page.tsx
│   │   ├── jobs/[id]/page.tsx
│   │   ├── jobs/[id]/edit/page.tsx
│   │   ├── runs/[id]/page.tsx
│   │   └── layout.tsx
│   ├── components/
│   ├── lib/api.ts
│   ├── Dockerfile
│   └── package.json
│
├── migrations/               # SQL migrations
│   ├── 001_init.sql
│   └── 002_seed_admin.sql
│
├── scripts/                  # Mounted into worker
│   ├── example_report.py
│   └── example_cleanup.sh
│
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Data Model

### users

| Column        | Type        | Notes |
|---------------|-------------|-------|
| id            | UUID PK     | |
| email         | TEXT UNIQUE | |
| password_hash | TEXT        | bcrypt |
| role          | TEXT        | `admin` |
| created_at    | TIMESTAMPTZ | |

### jobs

| Column          | Type        | Notes |
|-----------------|-------------|-------|
| id              | UUID PK     | |
| name            | TEXT        | |
| description     | TEXT        | |
| script_type     | TEXT        | `python`, `node`, `bash`, `go`, `custom` |
| script_path     | TEXT        | e.g. `/scripts/report.py` |
| script_content  | TEXT        | optional, if uploaded |
| args            | JSONB       | `["--month", "2026-09"]` |
| env             | JSONB       | `{"API_KEY": "..."}` |
| working_dir     | TEXT        | |
| timeout_seconds | INT         | default 300 |
| enabled         | BOOLEAN     | default true |
| created_by      | UUID FK     | users(id) |
| created_at      | TIMESTAMPTZ | |
| updated_at      | TIMESTAMPTZ | |

### schedules

| Column           | Type        | Notes |
|------------------|-------------|-------|
| id               | UUID PK     | |
| job_id           | UUID FK     | jobs(id) ON DELETE CASCADE |
| type             | TEXT        | `once`, `cron`, `interval` |
| run_at           | TIMESTAMPTZ | for `once` |
| cron_expr        | TEXT        | for `cron` |
| interval_seconds | INT         | for `interval` |
| timezone         | TEXT        | e.g. `Europe/Amsterdam` |
| next_run_at      | TIMESTAMPTZ | |
| enabled          | BOOLEAN     | |

### runs

| Column        | Type        | Notes |
|---------------|-------------|-------|
| id            | UUID PK     | |
| job_id        | UUID FK     | |
| status        | TEXT        | `queued`, `running`, `success`, `failed`, `timeout`, `canceled` |
| trigger_type  | TEXT        | `manual`, `schedule` |
| triggered_by  | UUID FK     | users(id), nullable |
| started_at    | TIMESTAMPTZ | |
| finished_at   | TIMESTAMPTZ | |
| exit_code     | INT         | |
| error_message | TEXT        | |
| worker_id     | TEXT        | |
| created_at    | TIMESTAMPTZ | |

### run_logs

| Column    | Type        | Notes |
|-----------|-------------|-------|
| id        | BIGSERIAL PK| |
| run_id    | UUID FK     | |
| timestamp | TIMESTAMPTZ | |
| stream    | TEXT        | `stdout`, `stderr` |
| message   | TEXT        | |

---

## Environment Variables

Create `.env` at project root:

```env
# Postgres
POSTGRES_USER=app
POSTGRES_PASSWORD=app
POSTGRES_DB=scheduler
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
DATABASE_URL=postgres://app:app@postgres:5432/scheduler?sslmode=disable

# Redis
REDIS_ADDR=redis:6379

# Auth
JWT_SECRET=change-me-in-production
JWT_EXPIRES_HOURS=24

# Admin seed
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=admin123

# API
API_PORT=8080
```

---

## Getting Started

### Prerequisites

- Docker
- Docker Compose
- (Optional, for local dev without Docker) Go 1.22+, Node 20+

### Run with Docker Compose

```bash
cd job-scheduler
cp .env.example .env
docker compose up --build
```

Then open:

- Frontend: http://localhost:3000
- API: http://localhost:8080

Login with the seeded admin:

```
email:    admin@example.com
password: admin123
```

Change these in production.

---

## Development Workflow

Recommended build order (backend first).

### Phase 1 — Database + migrations

1. Write `migrations/001_init.sql` with all tables.
2. Write `migrations/002_seed_admin.sql` with a bcrypt-hashed admin.
3. Bring up Postgres only:
   ```bash
     docker compose up postgres -d
   ```
4. Apply migrations manually or with a small migrate script.

**Done when:** you can `psql` in and see tables.

### Phase 2 — Go API skeleton + auth

1. Set up chi router with `/health`.
2. Add Postgres connection pool (pgx).
3. Implement `POST /api/auth/login` returning JWT.
4. Add admin middleware that verifies JWT and role.
5. Implement `GET /api/auth/me`.

**Done when:** `curl` login returns a token and `me` works with the token.

### Phase 3 — Jobs CRUD

1. `GET /api/jobs`, `POST /api/jobs`
2. `GET /api/jobs/{id}`, `PATCH`, `DELETE`
3. Validate `script_type` against allowlist.

**Done when:** you can create and list jobs with curl.

### Phase 4 — Manual run + Worker

1. Add `POST /api/jobs/{id}/run` → creates a `run` row (`queued`) and pushes run ID to Redis list `job_queue`.
2. Build worker: `BLPOP job_queue`, lock the run, execute script, stream logs.
3. Insert stdout/stderr into `run_logs`, also `PUBLISH` to `run:{id}`.
4. Update run status and exit code.

**Done when:** triggering a run creates logs you can read from Postgres.

### Phase 5 — Runs + SSE logs

1. `GET /api/jobs/{id}/runs`, `GET /api/runs/{id}`
2. `GET /api/runs/{id}/logs` (paginated)
3. `GET /api/runs/{id}/logs/stream` — SSE, subscribes to Redis channel.

**Done when:** `curl -N` on the SSE endpoint shows live lines.

### Phase 6 — Scheduler

1. Build scheduler binary.
2. Every 10 seconds: query due schedules with `FOR UPDATE SKIP LOCKED`.
3. For each: create run, push to Redis, compute `next_run_at`.
   - `once` → disable schedule
   - `cron` → next cron occurrence in timezone
   - `interval` → `now + interval_seconds`

**Done when:** a job scheduled 1 minute in the future runs without manual trigger.

### Phase 7 — Next.js UI

1. Login page + auth cookie/token.
2. Jobs list page.
3. Create / edit job form with schedule fields.
4. Job detail page with runs list.
5. Run detail page with live logs via `EventSource`.

**Done when:** full flow works end to end in the browser.

### Phase 8 — Polish

- Cancel running job (SIGTERM via worker).
- Retry failed run.
- Enable / disable schedule.
- Better status badges and filters.

### Phase 9 — Optional

- Docker-per-run isolation.
- Kafka event publishing.
- gRPC between scheduler and worker.
- File upload for scripts.

---

## API Reference

All routes require `Authorization: Bearer <token>` except login.

### Auth

```
POST   /api/auth/login
GET    /api/auth/me
POST   /api/auth/logout
```

### Jobs

```
GET    /api/jobs
POST   /api/jobs
GET    /api/jobs/{id}
PATCH  /api/jobs/{id}
DELETE /api/jobs/{id}
POST   /api/jobs/{id}/run
```

### Schedules

```
GET    /api/jobs/{id}/schedules
POST   /api/jobs/{id}/schedules
PATCH  /api/schedules/{id}
DELETE /api/schedules/{id}
```

### Runs

```
GET    /api/jobs/{id}/runs
GET    /api/runs/{id}
POST   /api/runs/{id}/cancel
GET    /api/runs/{id}/logs
GET    /api/runs/{id}/logs/stream   # SSE
```

### Example: create a job

```bash
curl -X POST http://localhost:8080/api/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Monthly report",
    "script_type": "python",
    "script_path": "/scripts/report.py",
    "args": ["--month", "2026-09"],
    "env": {"REPORT_ENV": "production"},
    "timeout_seconds": 300,
    "schedule": {
      "type": "once",
      "run_at": "2026-10-15T14:30:00+02:00",
      "timezone": "Europe/Amsterdam"
    }
  }'
```

---

## How It Works

1. Admin creates a job with a script type, path, args, and a schedule.
2. Scheduler checks due schedules every 10 seconds.
3. For each due schedule it creates a `run` row with status `queued`

   and pushes the run ID to Redis list `job_queue`.
4. Worker pops a run, atomically marks it `running`, and executes the

   script with the correct interpreter.
5. Worker captures stdout/stderr, writes to `run_logs`, and publishes

   each line to Redis channel `run:{id}`.
6. API forwards those lines to the browser over SSE.
7. On finish, worker updates status, exit code, and finish time.
8. If the schedule is recurring, the scheduler computes `next_run_at`.

   If it's a `once` schedule, it's disabled.

---

## Script Types

| Type     | Command executed |
|----------|------------------|
| `python` | `python3 <script_path> <args...>` |
| `node`   | `node <script_path> <args...>` |
| `bash`   | `bash <script_path> <args...>` |
| `go`     | `go run <script_path> <args...>` |
| `custom` | resolved by your own allowlist |

Arguments are always passed as separate argv entries, never via `sh -c`.

Example: a job with

```json
{ "script_type": "python", "script_path": "/scripts/report.py", "args": ["--month", "2026-09"] }
```

executes:

```
python3 /scripts/report.py --month 2026-09
```

---

## Scheduling

### Once

Runs at one exact time. After the run is created, the schedule is disabled.

```json
{ "type": "once", "run_at": "2026-10-15T14:30:00Z", "timezone": "UTC" }
```

### Cron

Standard 5-field cron expression.

```json
{ "type": "cron", "cron_expr": "0 9 * * *", "timezone": "Europe/Amsterdam" }
```

Runs every day at 09:00 Amsterdam time.

### Interval

Every N seconds.

```json
{ "type": "interval", "interval_seconds": 300, "timezone": "UTC" }
```

Every 5 minutes.

**Timezones:** store everything in UTC in the database.
Convert at display time and when computing `next_run_at` from a cron
expression using the schedule's timezone.

---

## Logs

Logs are stored in `run_logs` and also streamed live over Redis pub/sub.

- **Historical:** `GET /api/runs/{id}/logs?after=<log_id>&limit=200`
- **Live:** `GET /api/runs/{id}/logs/stream` (SSE)

Frontend uses `EventSource`:

```ts
const es = new EventSource(`/api/runs/${runId}/logs/stream`);
es.onmessage = (e) => appendLog(e.data);
```

Each message is one log line.

---

## Roadmap

- [x] Database schema
- [x] Admin auth
- [x] Jobs CRUD
- [x] Manual run
- [x] Worker with log streaming
- [x] Once / cron / interval schedules
- [ ] Live logs in UI
- [ ] Cancel running job
- [ ] Retry failed run
- [ ] Docker-per-run isolation
- [ ] File upload for scripts
- [ ] Artifacts storage
- [ ] Notifications (email / webhook)
- [ ] Kafka event stream
- [ ] gRPC worker control
- [ ] Multi-admin with roles

---

## Security Notes

This system executes arbitrary scripts. Treat it accordingly.

- Only admins can create jobs. No public signup.
- Validate `script_type` against an allowlist.
- Restrict scripts to a known directory, e.g. `/scripts`.
- Never build commands with `sh -c` and string interpolation.
- Always pass arguments as separate argv entries.
- Enforce a timeout on every run.
- Capture and store stderr and exit codes.
- For real isolation, run each job in a container:
  ```
  docker run --rm \
    --memory 256m --cpus 0.5 \
    --read-only --network none \
    -v /scripts:/scripts:ro \
    python:3.12 python /scripts/report.py --month 2026-09
  ```
- Rotate `JWT_SECRET` and change the seeded admin password.
- Never commit `.env`.

---

## License

MIT