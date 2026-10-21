# Taskflow frontend

Taskflow is the Next.js administrator interface for the Go Job Scheduler. It provides email/password login, job creation and manual execution, one-time/interval/cron schedules, automatic-job monitoring, execution history, live stdout/stderr, log downloads, and API/database status.

The backend is responsible for execution. The frontend does not run scripts, maintain timers that trigger jobs, or connect directly to PostgreSQL, Redis, or Docker. Closing the browser does not stop an enabled backend schedule.

See [the root README](../README.md) for backend configuration, Docker execution, database migrations, the complete API reference, SQL behavior, and reliability limits.

## Technology and configuration

| Area           | Implementation                                                         |
| -------------- | ---------------------------------------------------------------------- |
| Framework      | Next.js 16.4.2, App Router                                             |
| UI             | React 19.3.0 and TypeScript with strict checking                       |
| Styling        | Global CSS, Tailwind CSS 4 tooling, Geist fonts                        |
| Animation      | GSAP, scoped cleanup, reduced-motion preference                        |
| Icons          | Lucide React                                                           |
| API access     | Same-origin Next.js Route Handler proxy with a server-side backend URL |
| Authentication | Backend JWT held in an HTTP-only cookie                                |
| Live output    | EventSource/SSE with cursor-based history loading and polling fallback |
| Browser tests  | Playwright Chromium with a fixture API                                 |
| Code checks    | ESLint, TypeScript, Prettier                                           |

`next.config.ts` enables React Compiler, Cache Components, partial prefetching, Turbopack filesystem caches, the Tailwind Turbopack CSS loader, and experimental agent feedback. Workspace requests explicitly bypass caching. Browser-test mode uses a separate `.next-test` output directory so it can run alongside the normal development server.

This repository includes version-specific Next.js instructions in `AGENTS.md`. For framework changes, consult the documentation installed under `node_modules/next/dist/docs/`.

## Setup and startup

Start the backend from the repository root:

```bash
docker compose up -d --build
```

Then, from this directory:

```bash
npm ci
npm run dev
```

Open `http://localhost:3000` and sign in with the backend's configured **ADMIN_EMAIL** and **ADMIN_PASSWORD**. The login endpoint accepts an email, not `ADMIN_USERNAME`. There is no registration screen or registration endpoint.

The current Compose file contains literal admin credentials and a JWT secret. Update its API environment entries, or parameterize them, to change those settings; `.env` entries alone do not override literals. Existing accounts are seeded only if the email is absent, so changing a seed password does not reset an existing account.

### Environment variables

Create `.env.local` in this directory when the backend is not at its default address:

```dotenv
BACKEND_URL=http://127.0.0.1:8080
```

| Variable             | Default                 | Purpose                                                         |
| -------------------- | ----------------------- | --------------------------------------------------------------- |
| `BACKEND_URL`        | `http://127.0.0.1:8080` | API base address reachable from the Next.js server; omit `/api` |
| `TASKFLOW_TEST_MODE` | Unset                   | Set to `1` by Playwright to use `.next-test`                    |

`BACKEND_URL` is server-only. Do not rename it to `NEXT_PUBLIC_BACKEND_URL` or put database credentials/JWT secrets in client configuration. Restart Next.js after changing environment variables.

When deploying Next.js inside a container, `127.0.0.1` refers to that container. Use an address reachable from it, such as `http://api:8080` when attached to the backend Compose network. The current Compose configuration does not include the frontend itself.

### Production

```bash
npm ci
npm run build
npm start
```

Production cookies have the `Secure` attribute; use HTTPS through a suitable reverse proxy. Preserve the public request host and scheme when configuring the proxy because mutation requests validate their Origin against the request origin. SSE connections also need buffering disabled and a sufficiently long proxy timeout.

The layout uses `next/font/google` for Geist and Geist Mono, so builds need access to download those fonts. For an offline deployment, prepare a local-font setup before building. There is no frontend Dockerfile or deployment pipeline included.

## Workspace pages

| Page          | User actions and information                                                              |
| ------------- | ----------------------------------------------------------------------------------------- |
| Overview      | Job/run totals, recent activity, charts, and execution output from loaded backend history |
| Jobs          | Search/list jobs, inspect configuration, create a job, queue a manual execution           |
| Schedules     | Create, edit, enable, pause, delete, inspect next due time, or run the associated job now |
| Monitoring    | Read-only view of scheduled jobs and automatic executions, with filters and log links     |
| Run history   | Inspect and filter manual and scheduled runs                                              |
| Live logs     | Select a run, read stdout/stderr, filter output, follow scrolling, download loaded lines  |
| System status | API availability and PostgreSQL readiness                                                 |

The sidebar views are managed inside the client workspace; they are not separate URL routes. Workspace data reloads approximately every 15 seconds after the preceding load completes. **Refresh** reloads immediately. Errors and incomplete per-job loads are displayed rather than replacing failed data with invented success values.

### Creating a job

1. Add the file to the backend's mounted `scripts/` directory.
2. Select **Create job**, enter a name, runtime, script path, and timeout.
3. For ordinary scripts, enter an existing working directory under `/scripts`, JSON arguments, and JSON environment values as needed.
4. Leave the job enabled if it should run, then submit the form.
5. Use **Run job** for immediate execution, or create an automatic schedule separately.

Supported form runtimes are Python, Node.js, Bash, Go, and SQL. Paths must start with `/scripts/` and cannot contain parent-directory segments. The frontend cannot verify that a file exists on the worker host; that check occurs during execution. Creating a job successfully does not prove that its runtime, dependencies, or script will execute successfully.

Arguments must be an array of strings, for example `["--daily", "--limit", "100"]`. Environment must be an object with string values, for example `{"APP_ENV":"production"}`. These configure ordinary script jobs. There is no script upload/editor workflow because the worker executes mounted files rather than the API's stored `script_content` field.

SQL jobs require a `.sql` path and connection fields: engine, host, port, database/service name, username, password, and TLS options. Engine choices are PostgreSQL, MySQL, SQL Server, and Oracle; changing the engine selects its default port. Passwords follow the backend encryption flow and are not returned to the UI. Arguments, custom environment, and working-directory inputs are hidden for SQL because the SQL runner does not use them.

`custom` is accepted by the backend model but has no worker implementation, so the form excludes it. The backend has no job update/delete endpoint; existing job enablement cannot be changed through this UI after creation.

### Scheduling and Run now

A schedule belongs to an existing job. Both must be enabled for automatic dispatch.

| Schedule | Meaning                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------- |
| Interval | First run after the configured seconds; future due times are measured from dispatch, not completion  |
| Cron     | Five fields: minute, hour, day of month, month, day of week; evaluated in the supplied IANA timezone |
| One time | Browser-local date/time converted to a UTC timestamp; schedule becomes inactive after dispatch       |

The scheduler checks due work every five seconds. A due run may still wait for an available worker. Intervals do not mean “run immediately, then repeat”; use **Run now** if an extra immediate execution is wanted.

**Run now** starts a manual execution of the job and opens its logs. It preserves the automatic schedule's next due time. Pausing a schedule prevents future automatic dispatches but does not cancel runs already queued or running. Editing, pausing, or enabling a schedule uses the backend's full update payload and recalculates the next due time.

One-time forms require a future date. For cron, a value such as `0 9 * * 1-5` with `Asia/Tehran` means 09:00 on weekdays in that timezone. One-time inputs use the browser's local timezone regardless of the cron timezone field. The backend accepts IANA timezone names, not informal abbreviations or a separate seconds field.

### Monitoring automatic jobs

Use **Monitoring** when the goal is observation. It shows scheduled jobs, runnable enabled schedules, next-run countdowns, active automatic runs, latest automatic results, duration, exit code, and log links. Expand a job's schedule count to inspect its individual schedules.

Search by job and filter for active executions, latest results needing attention, inactive scheduling, or no automatic execution yet. This view makes no job/schedule mutations. The surrounding admin workspace still provides management features in other views; Monitoring is not a separate read-only user role.

Only runs with `trigger_type: "schedule"` count here. A newer successful manual run does not hide an earlier failed automatic result. Runs are grouped by job because the API does not return `schedule_id`; a job with several schedules cannot have each run attributed to a particular schedule.

A next-run countdown is timing information, not proof of execution. An inactive one-time schedule may already have been dispatched. Confirm execution from a run record: `running` means started, `success` with exit code `0` normally means completed successfully, and `failed`/`timeout` require inspecting the error and logs.

### Logs and history

The log viewer first paginates historical output in pages of 1,000, then opens SSE from the last log ID. Entries are deduplicated by ID. On the terminal `done` event, it fetches the final run state and drains remaining output. If streaming fails, it falls back to polling, normally every two seconds while the run is active, with retries after errors.

Controls filter stdout/stderr and toggle automatic scrolling. Downloads include **all loaded lines**, with timestamps and stream labels, regardless of the visible filter. Loaded logs remain in browser memory; there is no virtualized viewer for extremely large output.

Run history loads the latest 500 runs per job, matching the API. Overview totals and monitoring results reflect this loaded history rather than unlimited lifetime statistics. A job's older automatic runs can fall outside the available window.

## Frontend-to-backend contract

Browser requests go through `/api/backend/*` on the Next.js origin. The Route Handler uses a fixed method/path allowlist, forwards JSON requests and query parameters to Go, and streams upstream responses. It is not a generic arbitrary-URL proxy.

| Go endpoint                      | Frontend use                                 |
| -------------------------------- | -------------------------------------------- |
| `POST /api/auth/login`           | Administrator sign-in                        |
| `GET /api/auth/me`               | Restore/validate session                     |
| `GET /api/jobs`                  | Job list and workspace refresh               |
| `POST /api/jobs`                 | Job creation                                 |
| `POST /api/jobs/{id}/run`        | Run job / schedule Run now                   |
| `GET /api/jobs/{id}/runs`        | Overview, history, monitoring, run selection |
| `GET /api/jobs/{id}/schedules`   | Schedule list and monitoring                 |
| `POST /api/jobs/{id}/schedules`  | Create schedule                              |
| `PATCH /api/schedules/{id}`      | Edit, enable, pause                          |
| `DELETE /api/schedules/{id}`     | Delete after confirmation                    |
| `GET /api/runs/{id}`             | Selected run status                          |
| `GET /api/runs/{id}/logs`        | Historical output and polling fallback       |
| `GET /api/runs/{id}/logs/stream` | Live SSE                                     |
| `GET /health`                    | API availability                             |
| `GET /ready`                     | PostgreSQL readiness                         |

The browser path for backend health is `/api/backend/health`; the proxy forwards it to `/health`, without `/api`. Swagger remains directly available from the backend and is not proxied as a workspace operation.

Authentication flow:

1. The login form submits email/password to the same-origin proxy.
2. The proxy obtains `{token}` from Go and stores it in `scheduler_session`: HTTP-only, SameSite=Lax, path `/`, maximum age 24 hours, Secure in production.
3. The browser receives `{authenticated:true}` rather than the JWT. Subsequent proxy calls add the bearer header server-side. Tokens are not stored in localStorage or sessionStorage.
4. Go verifies the JWT and checks that its administrator still exists. Invalid/expired sessions return 401; the proxy clears the cookie and the client returns to login.
5. `POST /api/backend/auth/logout` clears the cookie locally. Go has no logout/revocation endpoint, so an independently copied JWT remains valid until expiry or backend validation rejects it.

The proxy rejects mutation requests with a supplied Origin that differs from the request origin. Ordinary upstream fetches time out after 15 seconds; SSE uses the request's connection lifetime instead. Backend reachability failures become a readable 502 response. No backend CORS changes are needed because browser-to-Go calls are handled by the Next.js server.

Health does not establish that the worker, scheduler, or Redis queue is processing jobs. The UI labels those checks according to the endpoints actually available.

## Code structure

```text
app/
  layout.tsx                    Metadata, fonts, root layout
  page.tsx                      Workspace entry point
  globals.css                   Theme, components, responsive layouts
  api/backend/[...path]/route.ts Allowlisted proxy and session cookie
components/
  scheduler-app.tsx             Session, navigation, refresh, dashboard, CRUD actions
  forms.tsx                     Login, accessible modals, job and schedule forms
  schedule-monitor.tsx          Read-only automatic execution monitoring
  log-viewer.tsx                Paginated logs, SSE, fallback polling, download
  animated.tsx                  Scoped GSAP entry transitions
lib/
  api.ts                        Typed fetch helper, API errors, display helpers
  types.ts                      Backend response types
  monitoring.ts                 Scheduled-job grouping and timing helpers
tests/
  fixture-api.mjs               Isolated in-memory API for browser tests
  workspace.spec.ts             Login, job/schedule workflows, logs, mobile UI
  monitoring.spec.ts            Monitoring logic, read-only view, Run now behavior
playwright.config.ts            Chromium and two test servers
```

Workspace refresh loads jobs first, then each job's runs and schedules in batches of up to six jobs. This matches the backend's per-job endpoints and bounds concurrency, but request count still grows with job count. There is no global paginated runs endpoint.

GSAP animates marked elements when the view/loading state changes and cleans up on teardown. Animations honor `prefers-reduced-motion`. Dialogs include focus trapping, Escape dismissal, focus restoration, and body scroll locking. Mobile navigation and loading/error/empty states are included.

## Development commands and tests

Run from `frontend/`:

```bash
npm run dev          # Local development server
npm run lint         # ESLint
npx tsc --noEmit      # TypeScript checking
npm run build        # Production compilation
npm start            # Serve a completed production build
npm run format       # Format application, components, libraries, and tests
```

For browser tests:

```bash
npx playwright install chromium
npm run test:e2e
```

On Linux, missing browser shared libraries may require Playwright's system-dependency installer with appropriate system privileges:

```bash
npx playwright install-deps chromium
```

Playwright starts a fixture API on `127.0.0.1:8099` and a Next.js development server on `127.0.0.1:3100`, with `BACKEND_URL` pointed at the fixture and `TASKFLOW_TEST_MODE=1`. Keep those ports free. The tests use one Chromium worker and do not reuse an existing server. `.next-test`, `test-results`, and `playwright-report` are generated/ignored output.

The suite checks login errors and cookie handling, proxy restrictions, job form validation and SQL fields, manual execution, interval/cron/one-time schedule flows, schedule pause/edit/delete, long log pagination, live output, downloads, mobile dialogs, read-only monitoring, and Run now preserving automatic timing.

These tests validate browser behavior against a fixture contract. They do not execute real scripts, test database migrations, prove queue recovery, or establish connectivity to all four SQL engines. Run the backend Go checks from the root and use a real stack for execution verification.

A useful manual smoke test is to create an enabled job pointing at a known script, run it, confirm `success` and expected logs, then add a short interval schedule and confirm a new run marked `schedule`. Pause it and check that no new automatic dispatch occurs after any already queued run finishes. Repeat with a future one-time schedule and a cron schedule in the intended timezone.

## Troubleshooting and current limits

| Problem                                   | Check                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| Cannot sign in                            | Backend availability, effective admin email/password, existing seeded account |
| Unexpected sign-out after database reset  | Sign in again; stale administrator JWTs are rejected                          |
| Cannot reach scheduler API                | `BACKEND_URL` from the server/container, backend port, environment reload     |
| Mutation rejected for Origin              | Public request host/scheme and reverse-proxy forwarding                       |
| Production login does not persist         | HTTPS is required for the Secure cookie                                       |
| Job creation succeeds but execution fails | Mounted file, working directory, runtime dependencies, worker error/logs      |
| Schedule is enabled but no run appears    | Enabled job, due time/timezone, scheduler and worker logs, Redis queue        |
| Logs stop streaming                       | Reverse-proxy buffering/timeouts; check polling fallback and backend health   |
| Build cannot download fonts               | Network access for `next/font/google`, or configure local fonts               |
| Browser test fails before opening a page  | Chromium installation, Linux shared libraries, free test ports                |

The backend does not expose job editing/deletion, registration, cancellation, retries, per-schedule run attribution, full-history pagination, or worker/Redis health. There is one administrator role, not a separate monitoring role. Scheduling and queue crash-recovery limitations are documented in the root README. UI controls and status labels should continue to reflect those actual capabilities when adding features.
