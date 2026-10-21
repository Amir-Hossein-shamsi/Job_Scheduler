"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  FileCode2,
  LayoutDashboard,
  ListFilter,
  LoaderCircle,
  LogOut,
  Menu,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, ApiError, dateTime, duration } from "@/lib/api";
import type { Job, Run, Schedule, User } from "@/lib/types";
import { Animated } from "./animated";
import { Brand, JobForm, Login, Modal, ScheduleForm } from "./forms";
import { LogViewer, Status } from "./log-viewer";
import { ScheduleMonitor } from "./schedule-monitor";

type View =
  | "Overview"
  | "Jobs"
  | "Schedules"
  | "Monitoring"
  | "Run history"
  | "Live logs"
  | "System";
const navigation: { name: View; icon: LucideIcon }[] = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Jobs", icon: Workflow },
  { name: "Schedules", icon: CalendarClock },
  { name: "Monitoring", icon: Activity },
  { name: "Run history", icon: Clock3 },
  { name: "Live logs", icon: Terminal },
];
const descriptions: Record<View, string> = {
  Overview: "A little clarity for everything running in the background.",
  Jobs: "Your scripts. One organized workspace.",
  Schedules: "Make the right things happen at the right time.",
  Monitoring:
    "Watch your scheduled jobs, upcoming runs, and execution results.",
  "Run history": "Every execution leaves a story. Find it here.",
  "Live logs": "A front-row seat to what’s happening behind the scenes.",
  System: "Keep an eye on the services behind your workspace.",
};

export default function SchedulerApp() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [sessionError, setSessionError] = useState("");
  useEffect(() => {
    let active = true;
    api<User>("auth/me")
      .then((profile) => {
        if (active) setUser(profile);
      })
      .catch((err) => {
        if (active && !(err instanceof ApiError && err.status === 401))
          setSessionError(err.message);
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    const expired = () => setUser(null);
    window.addEventListener("session-expired", expired);
    return () => {
      active = false;
      window.removeEventListener("session-expired", expired);
    };
  }, []);
  if (checking)
    return (
      <div className="app-loading">
        <Brand />
        <LoaderCircle className="spin" size={24} />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!user)
    return (
      <>
        {sessionError && (
          <div className="connection-banner" role="alert">
            {sessionError}
          </div>
        )}
        <Login
          onLogin={(profile) => {
            setUser(profile);
            setSessionError("");
          }}
        />
      </>
    );
  return <Workspace user={user} onLogout={() => setUser(null)} />;
}

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [view, setView] = useState<View>("Overview");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [jobFilter, setJobFilter] = useState("all");
  const [showJob, setShowJob] = useState(false);
  const [scheduleModal, setScheduleModal] = useState<{
    existing?: Schedule;
    jobId?: string;
  } | null>(null);
  const [detail, setDetail] = useState<Job | null>(null);
  const [deleteSchedule, setDeleteSchedule] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [health, setHealth] = useState<{
    api: boolean;
    database: boolean;
  } | null>(null);
  const [refreshed, setRefreshed] = useState<string>("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await api<Job[]>("jobs", { signal });
      // Bound concurrent requests when a workspace contains many jobs.
      const allRuns: Run[] = [],
        allSchedules: Schedule[] = [];
      let failures = 0;
      for (let index = 0; index < list.length; index += 6) {
        const results = await Promise.allSettled(
          list.slice(index, index + 6).map(async (job) => {
            const [jobRuns, jobSchedules] = await Promise.all([
              api<Run[]>(`jobs/${job.id}/runs`, { signal }),
              api<Schedule[]>(`jobs/${job.id}/schedules`, { signal }),
            ]);
            return { jobRuns, jobSchedules };
          }),
        );
        for (const result of results) {
          if (result.status === "fulfilled") {
            allRuns.push(...result.value.jobRuns);
            allSchedules.push(...result.value.jobSchedules);
          } else failures++;
        }
      }
      if (signal?.aborted) return;
      setJobs(list);
      setRuns(
        allRuns.sort(
          (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
        ),
      );
      setSchedules(allSchedules);
      setError(
        failures
          ? `History or schedules could not be loaded for ${failures} job(s). Displayed totals may be incomplete. Refresh to retry.`
          : "",
      );
      setRefreshed(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    } catch (err) {
      if (!signal?.aborted)
        setError(
          err instanceof Error ? err.message : "Could not load workspace.",
        );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  const checkHealth = useCallback(async (signal?: AbortSignal) => {
    const results = await Promise.allSettled([
      fetch("/api/backend/health", { cache: "no-store", signal }),
      fetch("/api/backend/ready", { cache: "no-store", signal }),
    ]);
    if (!signal?.aborted)
      setHealth({
        api: results[0].status === "fulfilled" && results[0].value.ok,
        database: results[1].status === "fulfilled" && results[1].value.ok,
      });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      await Promise.all([
        refresh(controller.signal),
        checkHealth(controller.signal),
      ]);
      if (!controller.signal.aborted) timer = setTimeout(tick, 15000);
    }
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh, checkHealth]);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 4500);
      return () => clearTimeout(timer);
    }
  }, [notice]);

  function navigate(next: View) {
    setView(next);
    setSearch("");
    setStatusFilter("all");
    setJobFilter("all");
    setMobileNav(false);
  }
  async function trigger(job: Job, openLogs = false) {
    setBusy(job.id);
    setError("");
    try {
      const run = await api<Run>(`jobs/${job.id}/run`, { method: "POST" });
      setSelectedRunId(run.id);
      setRuns((old) => [run, ...old.filter((item) => item.id !== run.id)]);
      setNotice(`${job.name} was added to the queue.`);
      if (openLogs) {
        setView("Live logs");
        setMobileNav(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not trigger job.");
    } finally {
      setBusy(null);
    }
  }
  async function toggleSchedule(schedule: Schedule) {
    setBusy(schedule.id);
    try {
      await api(`schedules/${schedule.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          type: schedule.type,
          run_at: schedule.run_at,
          cron_expr: schedule.cron_expr,
          interval_seconds: schedule.interval_seconds,
          timezone: schedule.timezone,
          enabled: !schedule.enabled,
        }),
      });
      await refresh();
      setNotice(schedule.enabled ? "Schedule paused." : "Schedule enabled.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update schedule.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function removeSchedule() {
    if (!deleteSchedule) return;
    setBusy(deleteSchedule.id);
    try {
      await api(`schedules/${deleteSchedule.id}`, { method: "DELETE" });
      setDeleteSchedule(null);
      await refresh();
      setNotice("Schedule deleted.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not delete schedule.",
      );
    } finally {
      setBusy(null);
    }
  }
  const updateRun = useCallback(
    (run: Run) =>
      setRuns((old) => old.map((item) => (item.id === run.id ? run : item))),
    [],
  );
  const jobNames = useMemo(
    () => new Map(jobs.map((job) => [job.id, job.name])),
    [jobs],
  );
  const filteredJobs = jobs.filter((job) =>
    `${job.name} ${job.description} ${job.script_type}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const filteredRuns = runs.filter(
    (run) =>
      (jobFilter === "all" || run.job_id === jobFilter) &&
      (statusFilter === "all" || run.status === statusFilter) &&
      `${jobNames.get(run.job_id)} ${run.id}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const filteredSchedules = schedules.filter((schedule) =>
    `${jobNames.get(schedule.job_id)} ${schedule.type} ${schedule.cron_expr || ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const selectedRun =
    runs.find((run) => run.id === selectedRunId) ||
    runs.find((run) => run.status === "running") ||
    runs[0];
  const activeRuns = runs.filter((run) =>
    ["queued", "running"].includes(run.status),
  );
  const finishedRuns = runs.filter(
    (run) => !["queued", "running"].includes(run.status),
  );
  const successRate = finishedRuns.length
    ? `${Math.round((finishedRuns.filter((run) => run.status === "success").length / finishedRuns.length) * 100)}%`
    : "—";
  const upcoming = schedules
    .filter((schedule) => schedule.enabled && schedule.next_run_at)
    .sort((a, b) => Date.parse(a.next_run_at!) - Date.parse(b.next_run_at!));
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="workspace">
      {mobileNav && (
        <div className="nav-backdrop" onClick={() => setMobileNav(false)} />
      )}
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <Brand />
        <div className="workspace-switch">
          <span className="workspace-avatar">W</span>
          <div>
            <strong>My workspace</strong>
            <span>Administrator</span>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav>
          {navigation.map(({ name, icon: Icon }) => (
            <button
              key={name}
              onClick={() => navigate(name)}
              className={`nav-item ${view === name ? "active" : ""}`}
            >
              <Icon size={18} />
              <span>{name}</span>
              {name === "Jobs" && (
                <span className="nav-count">{jobs.length}</span>
              )}
              {name === "Live logs" && activeRuns.length > 0 && (
                <span className="live-dot" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <span className="tip-icon">
              <Zap size={18} />
            </span>
            <h4>Set it. Let it run.</h4>
            <p>Put your repetitive work on a schedule.</p>
            <button
              onClick={() => {
                navigate("Schedules");
                if (jobs.length) setScheduleModal({});
              }}
            >
              Manage schedules <ArrowUpRight size={14} />
            </button>
          </div>
          <button
            className={`nav-item ${view === "System" ? "active" : ""}`}
            onClick={() => navigate("System")}
          >
            <Server size={17} />
            <span>System status</span>
            <span className={`tiny-dot ${health?.api ? "green" : ""}`} />
          </button>
          <div className="profile">
            <span className="profile-avatar">
              {user.email[0].toUpperCase()}
            </span>
            <div>
              <strong>Administrator</strong>
              <span title={user.email}>{user.email}</span>
            </div>
            <button
              className="icon-button"
              title="Sign out"
              aria-label="Sign out"
              onClick={async () => {
                try {
                  await api("auth/logout", { method: "POST" });
                  onLogout();
                } catch (err) {
                  setError(
                    err instanceof Error ? err.message : "Could not sign out.",
                  );
                }
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileNav(true)}
              aria-label="Open navigation"
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{view}</strong>
          </div>
          <div className="topbar-right">
            <span className="environment">
              <span className="tiny-dot green" /> ADMIN
            </span>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              aria-label="Open system information"
              title="System information"
              onClick={() => navigate("System")}
            >
              <CircleHelp size={18} />
            </button>
            <span className="top-avatar">{user.email[0].toUpperCase()}</span>
          </div>
        </header>
        <main>
          <Animated
            animationKey={`${view}-${loading ? "loading" : "ready"}`}
            className="page-content"
          >
            <div className="page-heading" data-animate>
              <div>
                <div className="eyebrow">YOUR WORKSPACE, AT A GLANCE</div>
                <h1>{view === "Overview" ? "Workspace overview" : view}</h1>
                <p>{descriptions[view]}</p>
              </div>
              <div className="heading-actions">
                <button
                  className="button secondary"
                  disabled={loading || busy === "refresh"}
                  onClick={async () => {
                    setBusy("refresh");
                    await Promise.all([refresh(), checkHealth()]);
                    setBusy(null);
                  }}
                >
                  <RefreshCw
                    size={15}
                    className={busy === "refresh" ? "spin" : ""}
                  />
                  <span>Refresh</span>
                </button>
                {view !== "Monitoring" && (
                  <button
                    className="button primary"
                    onClick={() =>
                      view === "Schedules"
                        ? setScheduleModal({})
                        : setShowJob(true)
                    }
                    disabled={view === "Schedules" && !jobs.length}
                  >
                    <Plus size={16} />
                    {view === "Schedules" ? "New schedule" : "Create job"}
                  </button>
                )}
              </div>
            </div>
            {error && (
              <div className="error-box workspace-error" role="alert">
                {error}
                <button
                  className="icon-button"
                  onClick={() => setError("")}
                  aria-label="Dismiss error"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {loading ? (
              <div className="loading-state">
                <LoaderCircle className="spin" size={24} />
                <p>Loading your scheduler…</p>
              </div>
            ) : (
              <>
                {view === "Overview" && (
                  <>
                    <div className="overview-date" data-animate>
                      <span>
                        <span
                          className={`tiny-dot ${health?.api ? "green" : ""}`}
                        />
                        {health === null
                          ? "Checking connection"
                          : health.api
                            ? "Connected to scheduler"
                            : "Scheduler unavailable"}
                      </span>
                      <span>
                        <CalendarClock size={13} />
                        {today}
                      </span>
                    </div>
                    <div className="stat-grid">
                      <Stat
                        label="Total jobs"
                        value={String(jobs.length).padStart(2, "0")}
                        icon={Workflow}
                        caption={`${jobs.filter((job) => job.enabled).length} enabled and ready`}
                        color="teal"
                      />
                      <Stat
                        label="Active runs"
                        value={String(activeRuns.length).padStart(2, "0")}
                        icon={Activity}
                        caption={`${activeRuns.filter((run) => run.status === "running").length} running · ${activeRuns.filter((run) => run.status === "queued").length} queued`}
                        color="blue"
                      />
                      <Stat
                        label="Success rate"
                        value={successRate}
                        icon={CheckCheck}
                        caption="Across loaded completed runs"
                        color="green"
                      />
                      <Stat
                        label="Active schedules"
                        value={String(
                          schedules.filter((schedule) => schedule.enabled)
                            .length,
                        ).padStart(2, "0")}
                        icon={CalendarClock}
                        caption={
                          upcoming.length
                            ? `Next: ${dateTime(upcoming[0].next_run_at)}`
                            : "Your next routine starts here"
                        }
                        color="amber"
                      />
                    </div>
                    <div className="dashboard-middle">
                      <ActivityChart runs={runs} />
                      <section className="panel upcoming-panel" data-animate>
                        <header className="panel-header">
                          <div className="panel-title">
                            <h3>Up next</h3>
                            <span className="count-badge">
                              {upcoming.length}
                            </span>
                          </div>
                          <button
                            className="icon-button"
                            onClick={() => navigate("Schedules")}
                            aria-label="View schedules"
                          >
                            <ArrowUpRight size={17} />
                          </button>
                        </header>
                        {upcoming.length ? (
                          <div className="upcoming-list">
                            {upcoming.slice(0, 4).map((schedule) => (
                              <button
                                key={schedule.id}
                                className="upcoming-item"
                                onClick={() =>
                                  setScheduleModal({ existing: schedule })
                                }
                              >
                                <span className="upcoming-icon">
                                  <CalendarClock size={17} />
                                </span>
                                <div>
                                  <strong>
                                    {jobNames.get(schedule.job_id)}
                                  </strong>
                                  <span>
                                    {schedule.type === "cron"
                                      ? schedule.cron_expr
                                      : schedule.type === "interval"
                                        ? `Every ${schedule.interval_seconds}s`
                                        : "One-time run"}{" "}
                                    · {schedule.timezone}
                                  </span>
                                </div>
                                <time>{dateTime(schedule.next_run_at)}</time>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="compact-empty">
                            <CalendarClock size={25} />
                            <h4>Make room for routine.</h4>
                            <p>Create a schedule to see what’s next.</p>
                            <button
                              className="text-button"
                              disabled={!jobs.length}
                              onClick={() => setScheduleModal({})}
                            >
                              Add a schedule <ArrowRight size={14} />
                            </button>
                          </div>
                        )}
                        <div className="panel-footnote">
                          <span className="tiny-dot green" /> The scheduler
                          checks due tasks every 5 seconds
                        </div>
                      </section>
                    </div>
                    <div className="section-heading" data-animate>
                      <div>
                        <h2>
                          Recent executions{" "}
                          <span className="count-badge">{runs.length}</span>
                        </h2>
                        <p>The latest from your background work.</p>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => navigate("Run history")}
                      >
                        View all runs <ArrowRight size={15} />
                      </button>
                    </div>
                    <RunTable
                      runs={runs.slice(0, 5)}
                      jobs={jobs}
                      onSelect={(run) => {
                        setSelectedRunId(run.id);
                        navigate("Live logs");
                      }}
                    />
                    <div className="bottom-grid">
                      <LogViewer
                        key={selectedRun?.id || "empty"}
                        run={selectedRun}
                        job={jobs.find((job) => job.id === selectedRun?.job_id)}
                        onUpdated={updateRun}
                      />
                      <section className="quick-start" data-animate>
                        <div className="eyebrow">
                          <Zap size={13} /> LESS BUSYWORK. MORE FLOW.
                        </div>
                        <h3>
                          Your next task,
                          <br />
                          on autopilot.
                        </h3>
                        <p>
                          Python, Node.js, Bash, Go, or SQL. Give your scripts a
                          reliable home.
                        </p>
                        <button
                          className="button secondary"
                          onClick={() => setShowJob(true)}
                        >
                          Create a job <Plus size={15} />
                        </button>
                        <div className="runtime-chips">
                          <span>Python</span>
                          <span>Node.js</span>
                          <span>SQL</span>
                          <span>+2</span>
                        </div>
                      </section>
                    </div>
                  </>
                )}
                {view === "Jobs" && (
                  <>
                    <div className="list-toolbar" data-animate>
                      <SearchField
                        value={search}
                        onChange={setSearch}
                        placeholder="Search jobs…"
                      />
                      <span className="muted">{filteredJobs.length} jobs</span>
                    </div>
                    {filteredJobs.length ? (
                      <div className="job-grid">
                        {filteredJobs.map((job) => (
                          <article
                            className="panel job-card"
                            key={job.id}
                            data-animate
                          >
                            <div className="job-card-top">
                              <span
                                className={`runtime-icon runtime-${job.script_type}`}
                              >
                                <FileCode2 size={21} />
                              </span>
                              <Status
                                value={job.enabled ? "enabled" : "disabled"}
                              />
                            </div>
                            <button
                              className="job-name-button"
                              onClick={() => setDetail(job)}
                            >
                              {job.name}
                              <ArrowUpRight size={16} />
                            </button>
                            <p>{job.description || "No description added."}</p>
                            <code className="job-path">{job.script_path}</code>
                            <div className="job-card-meta">
                              <span className="runtime-label">
                                {job.script_type}
                              </span>
                              <span>
                                <Clock3 size={12} />
                                {job.timeout_seconds}s timeout
                              </span>
                            </div>
                            <div className="job-card-actions">
                              <button
                                className="button secondary"
                                onClick={() => {
                                  setJobFilter(job.id);
                                  setView("Run history");
                                }}
                              >
                                View runs <ArrowRight size={14} />
                              </button>
                              <button
                                className="button primary"
                                disabled={!job.enabled || busy === job.id}
                                onClick={() => void trigger(job)}
                              >
                                {busy === job.id ? (
                                  <LoaderCircle size={14} className="spin" />
                                ) : (
                                  <Play size={14} />
                                )}
                                Run job
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <Empty
                        icon={Workflow}
                        title={
                          search
                            ? "No matching jobs"
                            : "Great routines start with one job."
                        }
                        description={
                          search
                            ? "Try another name or runtime."
                            : "Add a script or SQL job, then run it whenever you need."
                        }
                        action={!search ? "Create your first job" : undefined}
                        onAction={() => setShowJob(true)}
                      />
                    )}
                  </>
                )}
                {view === "Schedules" && (
                  <>
                    <div className="list-toolbar" data-animate>
                      <SearchField
                        value={search}
                        onChange={setSearch}
                        placeholder="Search schedules…"
                      />
                      <span className="muted">
                        {filteredSchedules.length} schedules
                      </span>
                    </div>
                    <div className="schedule-help" data-animate>
                      <CalendarClock size={16} />
                      <div>
                        <strong>Enabled schedules run automatically.</strong>
                        <p>
                          Interval: repeats after the chosen number of seconds.
                          One time: runs at the selected date. Cron: follows the
                          expression and timezone. Run now starts an extra
                          execution immediately and keeps the next scheduled
                          time.
                        </p>
                      </div>
                    </div>
                    {filteredSchedules.length ? (
                      <div className="panel table-scroll" data-animate>
                        <table>
                          <thead>
                            <tr>
                              <th>Job / schedule</th>
                              <th>Timing</th>
                              <th>Next run</th>
                              <th>Status</th>
                              <th className="align-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredSchedules.map((schedule) => (
                              <tr key={schedule.id}>
                                <td>
                                  <strong>
                                    {jobNames.get(schedule.job_id)}
                                  </strong>
                                  <small>
                                    {schedule.type} · {schedule.timezone}
                                  </small>
                                </td>
                                <td className="mono">
                                  {schedule.type === "cron"
                                    ? schedule.cron_expr
                                    : schedule.type === "interval"
                                      ? `Every ${schedule.interval_seconds}s`
                                      : dateTime(schedule.run_at)}
                                </td>
                                <td>
                                  {schedule.enabled
                                    ? dateTime(schedule.next_run_at)
                                    : schedule.type === "once"
                                      ? "No future run"
                                      : "Paused"}
                                </td>
                                <td>
                                  <Status
                                    value={
                                      schedule.enabled
                                        ? "enabled"
                                        : schedule.type === "once"
                                          ? "inactive"
                                          : "paused"
                                    }
                                  />
                                </td>
                                <td>
                                  <div className="row-actions">
                                    <button
                                      className="button secondary schedule-run-now"
                                      disabled={
                                        !jobs.find(
                                          (job) => job.id === schedule.job_id,
                                        )?.enabled || busy === schedule.job_id
                                      }
                                      title="Run this job now and open logs. Its automatic schedule stays in place."
                                      onClick={() => {
                                        const job = jobs.find(
                                          (job) => job.id === schedule.job_id,
                                        );
                                        if (job) void trigger(job, true);
                                      }}
                                    >
                                      {busy === schedule.job_id ? (
                                        <LoaderCircle
                                          className="spin"
                                          size={13}
                                        />
                                      ) : (
                                        <Play size={13} />
                                      )}
                                      Run now
                                    </button>
                                    <button
                                      className="icon-button"
                                      disabled={busy === schedule.id}
                                      onClick={() =>
                                        void toggleSchedule(schedule)
                                      }
                                      aria-label={
                                        schedule.enabled
                                          ? "Pause schedule"
                                          : "Enable schedule"
                                      }
                                    >
                                      {schedule.enabled ? (
                                        <Pause size={15} />
                                      ) : (
                                        <Play size={15} />
                                      )}
                                    </button>
                                    <button
                                      className="icon-button"
                                      onClick={() =>
                                        setScheduleModal({ existing: schedule })
                                      }
                                      aria-label="Edit schedule"
                                    >
                                      <Pencil size={15} />
                                    </button>
                                    <button
                                      className="icon-button danger"
                                      onClick={() =>
                                        setDeleteSchedule(schedule)
                                      }
                                      aria-label="Delete schedule"
                                    >
                                      <Trash2 size={15} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty
                        icon={CalendarClock}
                        title={
                          search ? "No matching schedules" : "Find your rhythm."
                        }
                        description={
                          jobs.length
                            ? "Run once, repeat on an interval, or use a cron expression."
                            : "Create a job first, then give it a schedule."
                        }
                        action={
                          jobs.length && !search
                            ? "Create a schedule"
                            : !search
                              ? "Create a job"
                              : undefined
                        }
                        onAction={() =>
                          jobs.length ? setScheduleModal({}) : setShowJob(true)
                        }
                      />
                    )}
                  </>
                )}
                {view === "Monitoring" && (
                  <ScheduleMonitor
                    jobs={jobs}
                    schedules={schedules}
                    runs={runs}
                    onViewRun={(run) => {
                      setSelectedRunId(run.id);
                      setView("Live logs");
                    }}
                  />
                )}
                {view === "Run history" && (
                  <>
                    <div className="list-toolbar wrap-toolbar" data-animate>
                      <SearchField
                        value={search}
                        onChange={setSearch}
                        placeholder="Search by job or run ID…"
                      />
                      <div className="filter-group">
                        <ListFilter size={15} />
                        <select
                          aria-label="Filter runs by job"
                          value={jobFilter}
                          onChange={(event) => setJobFilter(event.target.value)}
                        >
                          <option value="all">All jobs</option>
                          {jobs.map((job) => (
                            <option key={job.id} value={job.id}>
                              {job.name}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label="Filter runs by status"
                          value={statusFilter}
                          onChange={(event) =>
                            setStatusFilter(event.target.value)
                          }
                        >
                          <option value="all">All statuses</option>
                          {[
                            "queued",
                            "running",
                            "success",
                            "failed",
                            "timeout",
                            "canceled",
                          ].map((status) => (
                            <option key={status}>{status}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <RunTable
                      runs={filteredRuns}
                      jobs={jobs}
                      onSelect={(run) => {
                        setSelectedRunId(run.id);
                        setView("Live logs");
                      }}
                    />
                    <p className="data-note">
                      The API returns the latest 500 runs per job. Statistics
                      reflect this loaded history.
                    </p>
                  </>
                )}
                {view === "Live logs" && (
                  <>
                    <div className="list-toolbar" data-animate>
                      <div className="run-selector">
                        <Terminal size={17} />
                        <select
                          aria-label="Select a run to view logs"
                          value={selectedRun?.id || ""}
                          onChange={(event) =>
                            setSelectedRunId(event.target.value)
                          }
                        >
                          {!runs.length && (
                            <option value="">No runs yet</option>
                          )}
                          {runs.map((run) => (
                            <option key={run.id} value={run.id}>
                              {jobNames.get(run.job_id)} · {run.id.slice(0, 8)}{" "}
                              · {run.status}
                            </option>
                          ))}
                        </select>
                      </div>
                      <span className="muted">stdout + stderr</span>
                    </div>
                    <LogViewer
                      key={selectedRun?.id || "empty"}
                      run={selectedRun}
                      job={jobs.find((job) => job.id === selectedRun?.job_id)}
                      onUpdated={updateRun}
                    />
                    {selectedRun && (
                      <div className="run-detail-grid" data-animate>
                        {[
                          ["Run ID", selectedRun.id],
                          ["Trigger", selectedRun.trigger_type],
                          ["Started", dateTime(selectedRun.started_at)],
                          ["Worker", selectedRun.worker_id || "Not assigned"],
                        ].map(([label, value]) => (
                          <div className="panel" key={label}>
                            <span>{label}</span>
                            <code>{value}</code>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {view === "System" && (
                  <>
                    <div className="system-grid">
                      <Service
                        icon={Server}
                        name="Scheduler API"
                        description="HTTP server availability · /health"
                        connected={health?.api}
                      />
                      <Service
                        icon={Database}
                        name="PostgreSQL"
                        description="Database readiness · /ready"
                        connected={health?.database}
                      />
                      <section className="panel service-card" data-animate>
                        <span className="service-icon">
                          <ShieldCheck size={22} />
                        </span>
                        <h3>Admin session</h3>
                        <p>{user.email}</p>
                        <Status value="authenticated" />
                      </section>
                    </div>
                    <section className="panel system-info" data-animate>
                      <h3>About this workspace</h3>
                      <p>
                        Jobs run in temporary Docker containers. Manage Python,
                        Node.js, Bash, Go, and SQL tasks with one-time, cron, or
                        interval schedules.
                      </p>
                      <dl>
                        <div>
                          <dt>Automatic refresh</dt>
                          <dd>Every 15 seconds</dd>
                        </div>
                        <div>
                          <dt>Log delivery</dt>
                          <dd>Server-sent events, with polling fallback</dd>
                        </div>
                        <div>
                          <dt>Run history</dt>
                          <dd>Latest 500 runs per job</dd>
                        </div>
                        <div>
                          <dt>Queue and worker health</dt>
                          <dd>No health endpoint exposed by the backend</dd>
                        </div>
                      </dl>
                    </section>
                  </>
                )}
              </>
            )}
            <footer className="page-footer">
              <span>
                <span className="brand-mini">t.</span> A little structure. A lot
                of possibility.
              </span>
              <span>
                {refreshed ? `Updated ${refreshed}` : "Connecting"}
                <span className="tiny-dot" />
                Taskflow v1.0
              </span>
            </footer>
          </Animated>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <span className="small-check">
            <Check size={14} />
          </span>
          {notice}
          <button
            className="icon-button"
            onClick={() => setNotice("")}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {showJob && (
        <JobForm
          onClose={() => setShowJob(false)}
          onSaved={() => {
            setShowJob(false);
            setNotice("Your new job is ready.");
            void refresh();
          }}
        />
      )}
      {scheduleModal && (
        <ScheduleForm
          jobs={jobs}
          existing={scheduleModal.existing}
          initialJobId={scheduleModal.jobId}
          onClose={() => setScheduleModal(null)}
          onSaved={() => {
            setScheduleModal(null);
            setNotice("Schedule saved.");
            void refresh();
          }}
        />
      )}
      {deleteSchedule && (
        <Modal
          title="Delete this schedule?"
          subtitle={`Automatic runs for ${jobNames.get(deleteSchedule.job_id)} from this schedule will stop.`}
          onClose={() => setDeleteSchedule(null)}
        >
          <div className="config-form">
            <p className="muted">
              The job and its run history will stay available.
            </p>
            <footer className="form-footer">
              <button
                className="button secondary"
                onClick={() => setDeleteSchedule(null)}
                disabled={!!busy}
              >
                Keep schedule
              </button>
              <button
                className="button danger-button"
                disabled={!!busy}
                onClick={() => void removeSchedule()}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Trash2 size={16} />
                )}
                Delete schedule
              </button>
            </footer>
          </div>
        </Modal>
      )}
      {detail && (
        <Modal
          title={detail.name}
          subtitle={detail.description || "Job configuration"}
          onClose={() => setDetail(null)}
        >
          <div className="config-form job-details">
            <dl>
              {[
                ["Runtime", detail.script_type],
                ["Script", detail.script_path],
                ["Working directory", detail.working_dir],
                ["Timeout", `${detail.timeout_seconds}s`],
                ["Created", dateTime(detail.created_at)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <label>
              Arguments<pre>{JSON.stringify(detail.args, null, 2)}</pre>
            </label>
            <label>
              Environment<pre>{JSON.stringify(detail.env, null, 2)}</pre>
            </label>
            {detail.connection && (
              <label>
                SQL connection
                <pre>{JSON.stringify(detail.connection, null, 2)}</pre>
              </label>
            )}
            <footer className="form-footer">
              <button
                className="button secondary"
                onClick={() => {
                  const id = detail.id;
                  setDetail(null);
                  setScheduleModal({ jobId: id });
                }}
              >
                <CalendarClock size={15} />
                Add schedule
              </button>
              <button
                className="button primary"
                disabled={!detail.enabled || busy === detail.id}
                onClick={() => void trigger(detail)}
              >
                <Play size={15} />
                Run job
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  caption,
  icon: Icon,
  color,
}: {
  label: string;
  value: string;
  caption: string;
  icon: LucideIcon;
  color: string;
}) {
  return (
    <article className="panel stat-card" data-animate>
      <div className="stat-top">
        <span>{label}</span>
        <span className={`stat-icon ${color}`}>
          <Icon size={17} />
        </span>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-caption">
        <span
          className={`tiny-dot ${color === "teal" || color === "green" ? "green" : ""}`}
        />
        {caption}
      </div>
    </article>
  );
}

function ActivityChart({ runs }: { runs: Run[] }) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    date.setHours(0, 0, 0, 0);
    return date;
  });
  const bars = days.map((day) => {
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    const items = runs.filter(
      (run) =>
        Date.parse(run.created_at) >= day.getTime() &&
        Date.parse(run.created_at) < next.getTime(),
    );
    return {
      day,
      total: items.length,
      success: items.filter((run) => run.status === "success").length,
      failed: items.filter((run) =>
        ["failed", "timeout", "canceled"].includes(run.status),
      ).length,
    };
  });
  const max = Math.max(4, ...bars.map((bar) => bar.total));
  const total = bars.reduce((sum, bar) => sum + bar.total, 0);
  return (
    <section className="panel activity-panel" data-animate>
      <header className="panel-header">
        <div className="panel-title">
          <h3>Execution activity</h3>
          <span className="subtle-label">{total} runs</span>
        </div>
        <span className="period-label">
          Last 7 days <ChevronDown size={12} />
        </span>
      </header>
      <div className="chart-legend">
        <span>
          <i className="legend-success" />
          Success
        </span>
        <span>
          <i className="legend-failed" />
          Failed / timeout / canceled
        </span>
        <span>
          <i className="legend-active" />
          Active
        </span>
      </div>
      <div
        className="bar-chart"
        role="img"
        aria-label={`Execution activity over the last 7 days: ${bars.map((bar) => `${bar.day.toLocaleDateString(undefined, { weekday: "short" })} ${bar.total} runs`).join(", ")}`}
      >
        <div className="chart-axis">
          {[max, Math.round(max / 2), 0].map((value, index) => (
            <span key={index}>{value}</span>
          ))}
        </div>
        <div className="chart-plot">
          <div className="chart-grid-lines">
            <span />
            <span />
            <span />
          </div>
          <div className="chart-bars">
            {bars.map((bar, index) => (
              <div
                className={`chart-column ${index === 6 ? "today" : ""}`}
                key={bar.day.toISOString()}
              >
                <div className="bar-track">
                  <div
                    className="bar-stack"
                    style={{ height: `${(bar.total / max) * 100}%` }}
                    title={`${bar.total} runs · ${bar.success} succeeded · ${bar.failed} failed`}
                  >
                    <span
                      className="bar-active"
                      style={{ flex: bar.total - bar.success - bar.failed }}
                    />
                    <span className="bar-failed" style={{ flex: bar.failed }} />
                    <span
                      className="bar-success"
                      style={{ flex: bar.success }}
                    />
                  </div>
                </div>
                <span>
                  {bar.day.toLocaleDateString(undefined, { weekday: "short" })}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {!total && (
        <span className="chart-empty-note">
          Your first run will bring this chart to life.
        </span>
      )}
    </section>
  );
}

function RunTable({
  runs,
  jobs,
  onSelect,
}: {
  runs: Run[];
  jobs: Job[];
  onSelect: (run: Run) => void;
}) {
  return (
    <div className="panel table-scroll" data-animate>
      {runs.length ? (
        <table>
          <thead>
            <tr>
              <th>Job name</th>
              <th>Status</th>
              <th>Trigger</th>
              <th>Duration</th>
              <th>Started</th>
              <th className="align-right">Output</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const job = jobs.find((item) => item.id === run.job_id);
              return (
                <tr key={run.id}>
                  <td>
                    <div className="job-cell">
                      <span
                        className={`runtime-icon small runtime-${job?.script_type}`}
                      >
                        <FileCode2 size={15} />
                      </span>
                      <div>
                        <button
                          className="table-name"
                          onClick={() => onSelect(run)}
                        >
                          {job?.name || "Unknown job"}
                        </button>
                        <small>
                          #{run.id.slice(0, 8)}{" "}
                          <span>· {job?.script_type}</span>
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Status value={run.status} />
                  </td>
                  <td>
                    <span className="trigger-label">
                      {run.trigger_type === "manual" ? (
                        <Play size={12} />
                      ) : (
                        <CalendarClock size={13} />
                      )}
                      {run.trigger_type}
                    </span>
                  </td>
                  <td className="mono">
                    {duration(run.started_at, run.finished_at)}
                  </td>
                  <td>{dateTime(run.started_at || run.created_at)}</td>
                  <td className="align-right">
                    <button
                      className="logs-button"
                      onClick={() => onSelect(run)}
                    >
                      View logs <ArrowUpRight size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Empty
          icon={Clock3}
          title="A fresh start."
          description="Run a job and its execution history will appear here."
        />
      )}
    </div>
  );
}
function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="search-field">
      <Search size={16} />
      <input
        aria-label={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button
          className="icon-button"
          aria-label="Clear search"
          onClick={() => onChange("")}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
function Empty({
  icon: Icon,
  title,
  description,
  action,
  onAction,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state" data-animate>
      <span className="empty-icon">
        <Icon size={25} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <button className="button primary" onClick={onAction}>
          <Plus size={15} />
          {action}
        </button>
      )}
    </div>
  );
}
function Service({
  icon: Icon,
  name,
  description,
  connected,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  connected?: boolean;
}) {
  return (
    <section className="panel service-card" data-animate>
      <span className="service-icon">
        <Icon size={22} />
      </span>
      <h3>{name}</h3>
      <p>{description}</p>
      <Status
        value={
          connected === undefined
            ? "checking"
            : connected
              ? "healthy"
              : "unavailable"
        }
      />
    </section>
  );
}
