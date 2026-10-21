# Taskflow — Job Scheduler frontend

A responsive Next.js admin workspace for the Go Job Scheduler API. Includes GSAP page/form transitions, administrator login, job creation and manual execution, schedules, execution history, live stdout/stderr, log downloads, and API/database status.

## Run locally

Start the Go stack from the repository root using its existing Docker Compose configuration, then:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`. Sign in using the backend’s seeded **ADMIN_EMAIL** and **ADMIN_PASSWORD**. The backend login accepts an email, rather than ADMIN_USERNAME. There is no registration endpoint.

The Next.js server defaults to `http://127.0.0.1:8080` for the backend. To change this, create `frontend/.env.local`:

```env
BACKEND_URL=http://127.0.0.1:8080
```

Use a server-reachable address when deploying in containers. BACKEND_URL is server-only; do not prefix it with NEXT_PUBLIC_. No backend CORS changes are required.

For production, run `npm run build` followed by `npm start` behind HTTPS. Production session cookies are Secure. The existing `next/font/google` setup needs network access during the build to download Geist.

## Run scheduled jobs

In **Schedules**, enabled schedules execute automatically while the scheduler and worker services are running and the job is enabled. An interval waits its configured number of seconds before the first run; cron waits for the next matching time; a one-time schedule runs at its selected date and then becomes inactive. **Run now** starts an additional manual execution and opens its logs without moving the next automatic run.

## Monitor scheduled jobs

Open **Monitoring** in the sidebar for a read-only view of scheduled jobs, enabled schedules, next-run countdowns, active automatic runs, latest automatic results, durations, exit codes, and log links. Data refreshes every 15 seconds; Refresh updates it immediately. Search and filter for active runs, failed latest results, inactive scheduling, or jobs that have not run automatically yet. Expand a job’s schedule count to inspect its individual timings.

Runs are grouped by job because the backend does not return a schedule ID on executions. Only `trigger_type: "schedule"` counts in this view. An inactive one-time schedule may already have been dispatched; check its execution result. A due timestamp alone does not confirm execution.

## API coverage

| Backend endpoint | Workspace feature |
| --- | --- |
| `POST /api/auth/login`, `GET /api/auth/me` | Admin login and session validation |
| `GET /api/jobs`, `POST /api/jobs` | Job list, configuration details, create form |
| `POST /api/jobs/{id}/run` | Run job manually |
| `GET /api/jobs/{id}/runs` | Overview and filtered history |
| `GET /api/runs/{id}` | Run status and execution details |
| `GET /api/runs/{id}/logs` | Paginated historical output and polling fallback |
| `GET /api/runs/{id}/logs/stream` | Live SSE output |
| `GET/POST /api/jobs/{id}/schedules` | List and create schedules |
| `PATCH /api/schedules/{id}` | Edit, pause, or enable a schedule |
| `DELETE /api/schedules/{id}` | Delete with confirmation |
| `GET /health`, `GET /ready` | API availability and database readiness |

The allowlisted Next.js `/api/backend/*` handlers forward requests and store the JWT in an HTTP-only, SameSite cookie. The frontend never stores tokens in browser storage. Logout clears the cookie; the backend has no token revocation endpoint.

## Behavior and limitations

- Workspace data refreshes every 15 seconds. Dashboard counts and chart values come from the backend.
- History includes the latest 500 runs per job, matching the API limit; statistics reflect that loaded history.
- Logs paginate before opening SSE so completed runs with more than 1,000 lines are not truncated. If streaming fails, polling retries automatically. Downloads include all loaded lines, regardless of the visible stream filter.
- A script must already exist in the backend’s mounted `/scripts` directory. The API stores script content but the worker executes mounted files, so the frontend requests paths instead of offering a misleading upload/editor workflow.
- Python, Node.js, Bash, Go, and SQL are supported. The API accepts `custom`, but its executor is not implemented, so it is not offered in the form.
- SQL forms support PostgreSQL, MySQL, SQL Server, and Oracle. Connection passwords go to the existing backend encryption flow.
- Job editing/deletion, registration, cancellation, and worker/Redis health checks are not exposed by the current backend.
- Keyboard-accessible dialogs, responsive navigation, reduced-motion support, and explicit loading/error/empty states are included.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm run build
npm run test:e2e
```

Browser tests use a local fixture API and a real Next.js server; they do not run jobs against your database. Install Chromium once with `npx playwright install chromium`. This verifies frontend workflows and the proxy contract; a running Go/Postgres/Redis/Docker stack is still needed to verify real execution.
