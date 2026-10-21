"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Check,
  Code2,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Job, Schedule, User } from "@/lib/types";
import { Animated } from "./animated";

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <span />
        <span />
        <span />
      </span>
      <span>
        taskflow<span className="brand-dot">.</span>
      </span>
    </div>
  );
}

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      onLogin(await api<User>("auth/me"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Animated className="login-page">
      <section className="login-story">
        <Brand />
        <div className="story-content">
          <div className="eyebrow" data-animate>
            <span className="live-dot" /> YOUR OPERATIONS, IN SYNC
          </div>
          <h1 data-animate>
            Good work.
            <br />
            Right on <em>time.</em>
          </h1>
          <p data-animate>
            A calm command center for your scripts, schedules, and everything
            running behind the scenes.
          </p>
          <div className="orbit-illustration" aria-hidden="true" data-animate>
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="orbit orbit-three" />
            <div className="orbit-center">
              <Code2 size={34} />
            </div>
            <div className="orbit-tag tag-one">
              <span className="small-check">
                <Check size={13} />
              </span>{" "}
              Job completed <span className="muted">0.8s</span>
            </div>
            <div className="orbit-tag tag-two">
              <span className="live-dot" /> Next run scheduled
            </div>
            <span className="orbit-point point-one" />
            <span className="orbit-point point-two" />
          </div>
        </div>
        <div className="story-footer">
          <span>Built for the work that never stops.</span>
          <span>GO + NEXT.JS</span>
        </div>
      </section>
      <section className="login-form-side">
        <div className="login-top">
          <ShieldCheck size={15} /> ADMIN WORKSPACE
        </div>
        <div className="login-form-wrap">
          <span className="login-icon" data-animate>
            <LockKeyhole size={24} />
          </span>
          <h2 data-animate>Welcome back.</h2>
          <p className="muted" data-animate>
            Sign in to keep things moving.
          </p>
          <form onSubmit={submit} className="login-form">
            <label data-animate>
              Admin email
              <input
                name="email"
                type="email"
                placeholder="you@company.com"
                autoComplete="username"
                required
                autoFocus
              />
            </label>
            <label data-animate>
              Password
              <div className="password-input">
                <input
                  name="password"
                  type={visible ? "text" : "password"}
                  placeholder="Enter your admin password"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={visible ? "Hide password" : "Show password"}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
            <button
              className="button primary login-submit"
              disabled={busy}
              data-animate
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <>
                  Sign in to workspace <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <div className="login-note" data-animate>
            <ShieldCheck size={16} />
            <span>
              Private workspace. Use the administrator email and password
              configured for your scheduler.
            </span>
          </div>
        </div>
        <div className="login-bottom">
          <span>Taskflow / Job Scheduler</span>
          <span>
            Secure admin access <LockKeyhole size={12} />
          </span>
        </div>
      </section>
    </Animated>
  );
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = ref.current;
    dialog?.querySelector<HTMLElement>("input, select, button")?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab" && dialog) {
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
          ),
        );
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <Animated className="modal-animation">
        <div
          ref={ref}
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-title"
          data-animate
        >
          <header className="modal-header">
            <div>
              <div className="eyebrow">WORKSPACE / CONFIGURATION</div>
              <h2 id="modal-title">{title}</h2>
              <p className="muted">{subtitle}</p>
            </div>
            <button
              className="icon-button"
              onClick={onClose}
              aria-label="Close dialog"
            >
              <X size={21} />
            </button>
          </header>
          {children}
        </div>
      </Animated>
    </div>
  );
}

export function JobForm({
  onSaved,
  onClose,
}: {
  onSaved: () => void;
  onClose: () => void;
}) {
  const [type, setType] = useState("python");
  const [engine, setEngine] = useState("postgres");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const extensions: Record<string, string> = {
    python: "py",
    node: "js",
    bash: "sh",
    go: "go",
    sql: "sql",
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (key: string) => String(data.get(key) || "");
    setError("");
    try {
      const args: unknown = JSON.parse(text("args") || "[]");
      if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
        throw new Error(
          'Arguments must be a JSON array of strings, for example ["--verbose"].',
        );
      const env: unknown = JSON.parse(text("env") || "{}");
      if (
        !env ||
        Array.isArray(env) ||
        typeof env !== "object" ||
        !Object.values(env).every((value) => typeof value === "string")
      )
        throw new Error(
          'Environment must be a JSON object with string values, for example {"APP_ENV":"production"}.',
        );
      const path = text("script_path").trim();
      if (!path.startsWith("/scripts/") || path.split("/").includes(".."))
        throw new Error(
          "Choose a file inside /scripts/ without parent-directory segments.",
        );
      if (type === "sql" && !path.toLowerCase().endsWith(".sql"))
        throw new Error("SQL jobs require a .sql script file.");
      setBusy(true);
      await api<Job>("jobs", {
        method: "POST",
        body: JSON.stringify({
          name: text("name").trim(),
          description: text("description"),
          script_type: type,
          script_path: path,
          args,
          env,
          working_dir: type === "sql" ? "/scripts" : text("working_dir"),
          timeout_seconds: Number(text("timeout_seconds")),
          enabled: data.has("enabled"),
          ...(type === "sql"
            ? {
                connection: {
                  engine,
                  host: text("host"),
                  port: Number(text("port")),
                  database: text("database"),
                  username: text("username"),
                  password: text("password"),
                  tls_enabled: data.has("tls_enabled"),
                  trust_server_certificate: data.has(
                    "trust_server_certificate",
                  ),
                },
              }
            : {}),
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create job.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Create a job"
      subtitle="Give your next background task a place to run."
      onClose={onClose}
    >
      <form onSubmit={submit} className="config-form">
        <div className="form-grid">
          <label className="full">
            Job name
            <input
              name="name"
              placeholder="e.g. Daily inventory sync"
              required
              maxLength={200}
            />
          </label>
          <label className="full">
            Description <span className="optional">optional</span>
            <input
              name="description"
              placeholder="What does this job take care of?"
            />
          </label>
          <label>
            Runtime
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="python">Python</option>
              <option value="node">Node.js</option>
              <option value="bash">Bash</option>
              <option value="go">Go</option>
              <option value="sql">SQL</option>
            </select>
          </label>
          <label>
            Timeout (seconds)
            <input
              name="timeout_seconds"
              type="number"
              min="1"
              defaultValue="300"
              required
            />
          </label>
          <label className="full">
            Script path
            <input
              name="script_path"
              placeholder={`/scripts/task.${extensions[type]}`}
              required
            />
            <span className="field-help">
              The file must already exist in the backend’s mounted scripts
              directory.
            </span>
          </label>
          {type !== "sql" && (
            <>
              <label className="full">
                Working directory
                <input name="working_dir" defaultValue="/scripts" required />
                <span className="field-help">
                  Choose an existing directory inside /scripts.
                </span>
              </label>
              <label>
                Arguments <span className="optional">JSON array</span>
                <textarea
                  name="args"
                  defaultValue="[]"
                  rows={3}
                  spellCheck={false}
                  className="mono"
                />
              </label>
              <label>
                Environment <span className="optional">JSON object</span>
                <textarea
                  name="env"
                  defaultValue="{}"
                  rows={3}
                  spellCheck={false}
                  className="mono"
                />
              </label>
            </>
          )}
        </div>
        {type === "sql" && (
          <fieldset className="sql-fields">
            <legend>Database connection</legend>
            <div className="form-grid">
              <label>
                Engine
                <select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value)}
                >
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                  <option value="sqlserver">SQL Server</option>
                  <option value="oracle">Oracle</option>
                </select>
              </label>
              <label>
                Port
                <input
                  key={engine}
                  name="port"
                  type="number"
                  min="1"
                  max="65535"
                  defaultValue={
                    {
                      postgres: 5432,
                      mysql: 3306,
                      sqlserver: 1433,
                      oracle: 1521,
                    }[engine]
                  }
                  required
                />
              </label>
              <label>
                Host
                <input name="host" placeholder="db.example.internal" required />
              </label>
              <label>
                Database / service name
                <input name="database" required />
              </label>
              <label>
                Username
                <input name="username" autoComplete="off" required />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </label>
              <label className="checkbox-label">
                <input type="checkbox" name="tls_enabled" defaultChecked />{" "}
                Enable TLS
              </label>
              {engine === "sqlserver" && (
                <label className="checkbox-label">
                  <input type="checkbox" name="trust_server_certificate" />{" "}
                  Trust server certificate
                </label>
              )}
            </div>
          </fieldset>
        )}
        <label className="checkbox-label">
          <input type="checkbox" name="enabled" defaultChecked /> Enable this
          job
        </label>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <footer className="form-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Plus size={16} />
            )}{" "}
            Create job
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function ScheduleForm({
  jobs,
  existing,
  initialJobId,
  onSaved,
  onClose,
}: {
  jobs: Job[];
  existing?: Schedule;
  initialJobId?: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [type, setType] = useState(existing?.type || "cron");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    setBusy(true);
    try {
      const runAt = String(form.get("run_at") || "");
      if (type === "once" && new Date(runAt).getTime() <= Date.now())
        throw new Error("Choose a future date and time.");
      await api(
        existing
          ? `schedules/${existing.id}`
          : `jobs/${form.get("job_id")}/schedules`,
        {
          method: existing ? "PATCH" : "POST",
          body: JSON.stringify({
            type,
            timezone: form.get("timezone"),
            enabled: form.has("enabled"),
            ...(type === "cron"
              ? { cron_expr: form.get("cron_expr") }
              : type === "interval"
                ? { interval_seconds: Number(form.get("interval_seconds")) }
                : { run_at: new Date(runAt).toISOString() }),
          }),
        },
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save schedule.");
    } finally {
      setBusy(false);
    }
  }
  const localDate = existing?.run_at
    ? new Date(
        new Date(existing.run_at).getTime() -
          new Date(existing.run_at).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
  return (
    <Modal
      title={existing ? "Edit schedule" : "Create a schedule"}
      subtitle="Set the rhythm. We’ll take care of the timing."
      onClose={onClose}
    >
      <form className="config-form" onSubmit={submit}>
        <label>
          Job
          <select
            name="job_id"
            defaultValue={existing?.job_id || initialJobId || jobs[0]?.id}
            disabled={!!existing}
            required
          >
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.name}
                {!job.enabled ? " (disabled)" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented">
          {["cron", "interval", "once"].map((value) => (
            <button
              type="button"
              key={value}
              className={type === value ? "active" : ""}
              onClick={() => setType(value)}
            >
              {value === "once"
                ? "One time"
                : value === "cron"
                  ? "Cron expression"
                  : "Interval"}
            </button>
          ))}
        </div>
        {type === "cron" && (
          <label>
            Cron expression
            <input
              name="cron_expr"
              defaultValue={existing?.cron_expr || "0 9 * * *"}
              required
              className="mono"
            />
            <span className="field-help">
              Five fields: minute · hour · day · month · weekday. Example: 0 9 *
              * * runs daily at 09:00.
            </span>
          </label>
        )}
        {type === "interval" && (
          <label>
            Repeat every (seconds)
            <input
              name="interval_seconds"
              type="number"
              min="1"
              defaultValue={existing?.interval_seconds || 3600}
              required
            />
          </label>
        )}
        {type === "once" && (
          <label>
            Run at (your local time)
            <input
              name="run_at"
              type="datetime-local"
              defaultValue={localDate}
              required
            />
            <span className="field-help">Converted to UTC before saving.</span>
          </label>
        )}
        <label>
          Timezone
          <input
            name="timezone"
            defaultValue={existing?.timezone || "UTC"}
            placeholder="e.g. Asia/Tehran"
            required
          />
          <span className="field-help">
            IANA timezone used to evaluate cron expressions.
          </span>
        </label>
        <label className="checkbox-label">
          <input
            name="enabled"
            type="checkbox"
            defaultChecked={existing?.enabled ?? true}
          />{" "}
          Enable this schedule
        </label>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <footer className="form-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Check size={16} />
            )}{" "}
            {existing ? "Save changes" : "Create schedule"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
