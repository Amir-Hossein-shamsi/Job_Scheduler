# Job Scheduler

An admin-only Go job scheduler that runs scripts and SQL files in short-lived Docker containers. Jobs can be triggered manually or automatically with one-time, cron, or interval schedules. PostgreSQL stores jobs, schedules, runs, and logs; Redis provides the run queue.

## What is implemented

- JWT login for the seeded administrator.
- Job creation and listing through the API.
- Python, Node.js, Bash, and Go script execution.
- SQL execution for PostgreSQL, MySQL, Microsoft SQL Server, and Oracle.
- One Docker container per non-SQL and SQL run.
- Read-only `/scripts` mount, read-only container root, dropped capabilities, `no-new-privileges`, process limits, CPU and memory limits, and timeouts.
- Network disabled for regular scripts by default.
- Network enabled only for SQL runner containers so they can reach SQL Server or Oracle.
- PostgreSQL-backed run history and live log polling/SSE.
- One-time, cron, and interval schedules.

There is no public registration endpoint. The administrator is seeded from environment variables when the API starts.

## Architecture

```text
                         PostgreSQL
                       /      |      \
                      /       |       \
                 API ------ Redis ------ Scheduler
                  |           |             |
                  |           |             |
                  +--------- Worker --------+
                              |
                    Docker SDK creates one
                    temporary container per run
```

Services in `docker-compose.yml`:

| Service | Purpose |
| --- | --- |
| `postgres` | Stores users, jobs, schedules, runs, and logs. |
| `redis` | Stores the `job_queue` list. |
| `api` | Authentication, job APIs, run APIs, schedule APIs, and Swagger. |
| `worker` | Claims queued runs and starts sandbox containers through the Docker SDK. |
| `scheduler` | Claims due schedules and enqueues runs automatically. |

## Repository layout

```text
api/                    Go HTTP API
internal/dockerexec/    Docker SDK container lifecycle
internal/sqljob/        Encrypted SQL credentials and database connections
sqlrunner/              SQL runner binary executed inside SQL containers
scheduler/              Automatic schedule processor
worker/                 Redis worker and run state management
migrations/             PostgreSQL schema and SQL connection migration
scripts/                Read-only scripts mounted into run containers
```

## Requirements

- Docker Engine with Compose.
- Permission for the worker container to access `/var/run/docker.sock`.
- An absolute host path for the `scripts` directory.
- A base64-encoded 32-byte `SQL_CREDENTIALS_KEY`.

## Configuration

Create or update `.env` in the repository root:

```env
POSTGRES_USER=app
POSTGRES_PASSWORD=app
POSTGRES_DB=scheduler
REDIS_ADDR=redis:6379

JWT_SECRET=change-this-development-secret-to-at-least-32-characters
ADMIN_EMAIL=admin@example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-development-password

# Exactly 32 random bytes, encoded with base64.
SQL_CREDENTIALS_KEY=replace-with-base64-32-byte-key

# Absolute path on the Docker daemon host.
SCRIPTS_HOST_PATH=/absolute/path/to/job_scheduler/scripts

API_PORT=8080
```

Generate a valid SQL encryption key with:

```bash
openssl rand -base64 32
```

Optional worker settings:

```env
JOB_CONTAINER_MEMORY_BYTES=268435456
JOB_CONTAINER_NANO_CPUS=500000000
JOB_CONTAINER_PIDS_LIMIT=128
JOB_CONTAINER_NETWORK_DISABLED=true
```

## Start the application

Set `SCRIPTS_HOST_PATH` to an absolute path, then run:

```bash
docker compose up --build
```

The API is available at `http://localhost:8080`.

Swagger UI is available at:

```text
go run github.com/swaggo/swag/cmd/swag@v1.16.6 init -g api/main.go -o docs --parseDependency --parseInternal
http://localhost:8080/swagger/index.html
```

The Docker socket gives the worker control over the Docker daemon. Run this stack only in a trusted environment.

## Login

```bash
curl -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"change-this-development-password"}'
```

Save the returned token:

```bash
TOKEN='your-jwt-token'
```

## Create and run a script job

The script path is resolved inside the worker at `/scripts`. The file must exist in the host directory configured by `SCRIPTS_HOST_PATH`.

```bash
curl -X POST http://localhost:8080/api/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Hello Python",
    "description": "Run the example Python script",
    "script_type": "python",
    "script_path": "/scripts/hello.py",
    "args": [],
    "env": {"APP_ENV":"test"},
    "working_dir": "/scripts",
    "timeout_seconds": 60,
    "enabled": true
  }'
```

Trigger the job manually:

```bash
curl -X POST http://localhost:8080/api/jobs/{job_id}/run \
  -H "Authorization: Bearer $TOKEN"
```

Read run output:

```bash
curl http://localhost:8080/api/runs/{run_id}/logs \
  -H "Authorization: Bearer $TOKEN"
```

Stream logs until the run finishes:

```bash
curl -N http://localhost:8080/api/runs/{run_id}/logs/stream \
  -H "Authorization: Bearer $TOKEN"
```

## Create an automatic schedule

Schedules are created after the job exists. The scheduler polls due schedules every five seconds.

One-time schedule:

```bash
curl -X POST http://localhost:8080/api/jobs/{job_id}/schedules \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "once",
    "run_at": "2026-10-18T12:00:00Z",
    "timezone": "UTC",
    "enabled": true
  }'
```

Cron schedule using the standard five-field format:

```bash
curl -X POST http://localhost:8080/api/jobs/{job_id}/schedules \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "cron",
    "cron_expr": "*/5 * * * *",
    "timezone": "America/New_York",
    "enabled": true
  }'
```

Interval schedule, in seconds:

```bash
curl -X POST http://localhost:8080/api/jobs/{job_id}/schedules \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "interval",
    "interval_seconds": 3600,
    "timezone": "UTC",
    "enabled": true
  }'
```

Schedule endpoints:

```text
GET    /api/jobs/{job_id}/schedules
POST   /api/jobs/{job_id}/schedules
PATCH  /api/schedules/{schedule_id}
DELETE /api/schedules/{schedule_id}
```

## SQL jobs

Create a SQL job with `script_type: "sql"`, a `.sql` file under `/scripts`, and an encrypted connection configuration. Supported engines are `postgres`, `mysql`, `sqlserver`, and `oracle`.

SQL Server example:

```json
{
  "name": "SQL Server report",
  "script_type": "sql",
  "script_path": "/scripts/report.sql",
  "timeout_seconds": 300,
  "connection": {
    "engine": "sqlserver",
    "host": "sqlserver.example.internal",
    "port": 1433,
    "database": "reports",
    "username": "report_user",
    "password": "replace-me",
    "tls_enabled": true,
    "trust_server_certificate": false
  }
}
```

Oracle example:

```json
{
  "name": "Oracle report",
  "script_type": "sql",
  "script_path": "/scripts/report.sql",
  "timeout_seconds": 300,
  "connection": {
    "engine": "oracle",
    "host": "oracle.example.internal",
    "port": 1521,
    "database": "ORCLPDB1",
    "username": "report_user",
    "password": "replace-me",
    "tls_enabled": false
  }
}
```

The password is encrypted before storage. The SQL container receives the encrypted connection data and decrypts it only for that run. SQL containers have network access so they can reach the target database; regular script containers do not have network access by default.

## Supported script types

| Type | Command |
| --- | --- |
| `python` | `python3 /scripts/file.py ...` |
| `node` | `node /scripts/file.js ...` |
| `bash` | `bash /scripts/file.sh ...` |
| `go` | `go run /scripts/file.go ...` |
| `sql` | `/usr/local/bin/sqlrunner` inside a network-enabled sandbox |

Arguments are passed as separate argv entries. Commands are not assembled with `sh -c`.

`custom` is accepted by the current request model but does not have an executor implementation yet.

## Run statuses and logs

Runs use these statuses:

```text
queued, running, success, failed, timeout, canceled
```

Output is stored in `run_logs` with separate `stdout` and `stderr` streams. The API exposes both paginated logs and an SSE stream.

## Security notes

- The worker requires Docker socket access, which is equivalent to powerful control over the Docker host.
- Scripts are restricted to the configured `/scripts` directory.
- Script containers use a read-only root filesystem, read-only scripts mount, dropped capabilities, `no-new-privileges`, memory/CPU/PID limits, and a timeout.
- SQL containers require network access and should only connect to approved database hosts.
- Do not place secrets in script files or commit `.env` to source control.
- Change the development JWT secret and admin password before deployment.

## Verification

The repository can be checked with:

```bash
GOCACHE=/tmp/job-scheduler-go-cache go test ./...
GOCACHE=/tmp/job-scheduler-go-cache go vet ./...
docker compose config
```
