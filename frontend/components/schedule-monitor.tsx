"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  CalendarClock,
  Eye,
  Search,
} from "lucide-react";
import { dateTime, duration } from "@/lib/api";
import { scheduledJobs, untilNext } from "@/lib/monitoring";
import type { Job, Run, Schedule } from "@/lib/types";
import { Status } from "./log-viewer";

export function ScheduleMonitor({
  jobs,
  schedules,
  runs,
  onViewRun,
}: {
  jobs: Job[];
  schedules: Schedule[];
  runs: Run[];
  onViewRun: (run: Run) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const rows = useMemo(
    () => scheduledJobs(jobs, schedules, runs),
    [jobs, schedules, runs],
  );
  const activeRuns = rows.reduce((sum, row) => sum + row.activeRuns.length, 0);
  const attention = rows.filter((row) => row.needsAttention).length;
  const visible = rows.filter((row) => {
    const matches =
      `${row.job.name} ${row.job.script_type} ${row.job.script_path}`
        .toLowerCase()
        .includes(query.toLowerCase());
    return (
      matches &&
      (filter === "all" ||
        (filter === "active" && row.activeRuns.length > 0) ||
        (filter === "attention" && row.needsAttention) ||
        (filter === "inactive" &&
          (!row.job.enabled || !row.enabledSchedules.length)) ||
        (filter === "waiting" && !row.latestRun))
    );
  });
  return (
    <div className="schedule-monitor">
      <div className="monitor-notice" data-animate>
        <Eye size={16} />
        <span>
          Read-only monitoring{" "}
          <span className="muted">· Data refreshes every 15 seconds</span>
        </span>
        <span className="live-dot" />
      </div>
      <div className="monitor-metrics" data-animate>
        {[
          ["Scheduled jobs", rows.length],
          [
            "Enabled schedules",
            rows.reduce(
              (sum, row) =>
                sum + (row.job.enabled ? row.enabledSchedules.length : 0),
              0,
            ),
          ],
          ["Active automatic runs", activeRuns],
          ["Latest run needs attention", attention],
        ].map(([label, value]) => (
          <div className="panel monitor-metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="list-toolbar wrap-toolbar" data-animate>
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Search monitored jobs"
            placeholder="Search scheduled jobs…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <select
          className="monitor-filter"
          aria-label="Filter monitored jobs"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">All scheduled jobs</option>
          <option value="active">Running or queued</option>
          <option value="attention">Latest run needs attention</option>
          <option value="waiting">No automatic runs yet</option>
          <option value="inactive">Scheduling inactive</option>
        </select>
      </div>
      {visible.length ? (
        <div className="panel table-scroll" data-animate>
          <table className="monitor-table">
            <thead>
              <tr>
                <th>Scheduled job</th>
                <th>Scheduling</th>
                <th>Next automatic run</th>
                <th>Latest automatic execution</th>
                <th>Duration / exit</th>
                <th className="align-right">Output</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.job.id}>
                  <td>
                    <strong>{row.job.name}</strong>
                    <small>
                      {row.job.script_type} · {row.job.script_path}
                    </small>
                    <details className="monitor-schedules">
                      <summary>
                        {row.schedules.length}{" "}
                        {row.schedules.length === 1 ? "schedule" : "schedules"}
                      </summary>
                      <div>
                        {row.schedules.map((schedule) => (
                          <div key={schedule.id}>
                            <span className="mono">
                              {schedule.type === "cron"
                                ? schedule.cron_expr
                                : schedule.type === "interval"
                                  ? `Every ${schedule.interval_seconds}s`
                                  : dateTime(schedule.run_at)}
                            </span>
                            <span>
                              {schedule.timezone} ·{" "}
                              {schedule.enabled ? "Enabled" : "Inactive"}
                            </span>
                            <span>
                              {schedule.enabled
                                ? `Next: ${dateTime(schedule.next_run_at)}`
                                : schedule.type === "once"
                                  ? "One-time schedule is inactive after dispatch or when disabled."
                                  : "Schedule is disabled."}
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  </td>
                  <td>
                    <Status
                      value={
                        !row.job.enabled
                          ? "disabled"
                          : row.enabledSchedules.length
                            ? "enabled"
                            : "inactive"
                      }
                    />
                    {!row.job.enabled && <small>Job is disabled</small>}
                    {row.activeRuns.length > 0 && (
                      <small className="monitor-active">
                        <Activity size={11} />
                        {row.activeRuns.length} active{" "}
                        {row.activeRuns.length === 1 ? "run" : "runs"}
                      </small>
                    )}
                  </td>
                  <td>
                    {row.nextRun ? (
                      <>
                        <time dateTime={row.nextRun}>
                          {dateTime(row.nextRun)}
                        </time>
                        <small
                          className={
                            Date.parse(row.nextRun) <= now ? "monitor-due" : ""
                          }
                        >
                          {untilNext(row.nextRun, now)}
                        </small>
                      </>
                    ) : (
                      <>
                        <span>No next run</span>
                        <small>
                          {!row.job.enabled
                            ? "Job is disabled"
                            : "No enabled schedule with a next run"}
                        </small>
                      </>
                    )}
                  </td>
                  <td>
                    {row.latestRun ? (
                      <>
                        <Status value={row.latestRun.status} />
                        <small>
                          {dateTime(
                            row.latestRun.started_at ||
                              row.latestRun.created_at,
                          )}{" "}
                          · #{row.latestRun.id.slice(0, 8)}
                        </small>
                        {row.latestRun.error_message && (
                          <small
                            className="monitor-error"
                            title={row.latestRun.error_message}
                          >
                            {row.latestRun.error_message}
                          </small>
                        )}
                      </>
                    ) : (
                      <span className="muted">No automatic runs yet</span>
                    )}
                  </td>
                  <td className="mono">
                    {row.latestRun ? (
                      <>
                        {duration(
                          row.latestRun.started_at,
                          row.latestRun.finished_at,
                        )}
                        <small>
                          {row.latestRun.exit_code != null
                            ? `Exit code ${row.latestRun.exit_code}`
                            : "Exit code pending"}
                        </small>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="align-right">
                    {row.latestRun ? (
                      <button
                        className="logs-button"
                        onClick={() => onViewRun(row.latestRun!)}
                      >
                        View logs <ArrowUpRight size={13} />
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel empty-state" data-animate>
          <span className="empty-icon">
            <CalendarClock size={25} />
          </span>
          <h3>
            {rows.length
              ? "No jobs match this view."
              : "No scheduled jobs yet."}
          </h3>
          <p>
            {rows.length
              ? "Try another search or monitoring filter."
              : "Jobs will appear here after you add a schedule in Schedules."}
          </p>
        </div>
      )}
      <p className="data-note monitor-footnote">
        Execution status includes automatic runs only; manual runs do not count.
        When a job has multiple schedules, its latest automatic execution is
        shown across those schedules.
      </p>
      <p className="data-note monitor-footnote">
        Due means the recorded time has arrived; it does not confirm the worker
        has started. History reflects the latest 500 runs per job. Inactive
        one-time schedules may already have been dispatched.
      </p>
    </div>
  );
}
