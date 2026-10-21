"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Download,
  LoaderCircle,
  Radio,
  Terminal,
} from "lucide-react";
import { api, dateTime, duration } from "@/lib/api";
import type { Job, Log, Run } from "@/lib/types";

export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      <span />
      {value}
    </span>
  );
}

export function LogViewer({
  run,
  job,
  onUpdated,
}: {
  run?: Run;
  job?: Job;
  onUpdated: (run: Run) => void;
}) {
  const [logs, setLogs] = useState<Log[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!!run);
  const [following, setFollowing] = useState(true);
  const [filter, setFilter] = useState("all");
  const [streaming, setStreaming] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const updateRef = useRef(onUpdated);
  useEffect(() => {
    updateRef.current = onUpdated;
  }, [onUpdated]);
  const id = run?.id;
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let polling = false;
    const seen = new Set<number>();
    function append(entries: Log[]) {
      const fresh = entries.filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        cursor = Math.max(cursor, entry.id);
        return true;
      });
      if (fresh.length) setLogs((old) => [...old, ...fresh]);
    }
    async function drain() {
      // Paginate before opening SSE: the Go stream emits done after its first
      // page for completed runs, so opening SSE alone would truncate history.
      while (!controller.signal.aborted) {
        const page = await api<Log[]>(
          `runs/${id}/logs?after=${cursor}&limit=1000`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        append(page);
        if (page.length < 1000) break;
      }
    }
    async function poll() {
      if (controller.signal.aborted) return;
      try {
        await drain();
        const latest = await api<Run>(`runs/${id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        updateRef.current(latest);
        setError("");
        setLoading(false);
        if (["queued", "running"].includes(latest.status))
          timer = setTimeout(poll, 2000);
        else {
          await drain();
          setStreaming(false);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Could not read logs.");
          setLoading(false);
          timer = setTimeout(poll, 5000);
        }
      }
    }
    async function start() {
      try {
        await drain();
        if (controller.signal.aborted) return;
        setLoading(false);
        source = new EventSource(
          `/api/backend/runs/${id}/logs/stream?after=${cursor}&limit=1000`,
        );
        source.onopen = () => {
          setStreaming(true);
          setError("");
        };
        source.onmessage = (event) => {
          try {
            append([JSON.parse(event.data) as Log]);
          } catch {
            /* Ignore malformed stream frames; polling recovers them. */
          }
        };
        source.addEventListener("done", () => {
          source?.close();
          setStreaming(false);
          if (!polling) {
            polling = true;
            void poll();
          }
        });
        source.onerror = () => {
          source?.close();
          setStreaming(false);
          if (!polling) {
            polling = true;
            void poll();
          }
        };
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Could not load logs.");
          setLoading(false);
          polling = true;
          void poll();
        }
      }
    }
    void start();
    return () => {
      controller.abort();
      source?.close();
      clearTimeout(timer);
    };
  }, [id]);
  useEffect(() => {
    if (following && outputRef.current)
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [logs, following]);
  function download() {
    const blob = new Blob(
      [
        logs
          .map(
            (entry) => `${entry.timestamp} [${entry.stream}] ${entry.message}`,
          )
          .join("\n"),
      ],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `run-${id}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  const visible = logs.filter(
    (entry) => filter === "all" || entry.stream === filter,
  );
  return (
    <section className="panel log-panel" data-animate>
      <header className="panel-header">
        <div className="panel-title">
          <Terminal size={17} />
          <h3>Execution output</h3>
          {streaming && (
            <span className="live-label">
              <span className="live-dot" /> LIVE
            </span>
          )}
        </div>
        <div className="toolbar">
          <button
            className={`icon-button ${following ? "selected" : ""}`}
            aria-label={
              following ? "Pause automatic scrolling" : "Follow latest logs"
            }
            title="Follow latest logs"
            onClick={() => setFollowing(!following)}
          >
            <ArrowDownToLine size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Download loaded logs"
            title="Download loaded logs"
            disabled={!logs.length}
            onClick={download}
          >
            <Download size={16} />
          </button>
        </div>
      </header>
      {run ? (
        <>
          <div className="log-meta">
            <span>
              {job?.name || "Job run"}
              <code>#{run.id.slice(0, 8)}</code>
            </span>
            <Status value={run.status} />
          </div>
          <div className="log-filters">
            <div className="tabs">
              {["all", "stdout", "stderr"].map((value) => (
                <button
                  key={value}
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {value === "all" ? "All output" : value}
                </button>
              ))}
            </div>
            <span>
              {logs.length} lines · {duration(run.started_at, run.finished_at)}
            </span>
          </div>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          {run.error_message && (
            <div className="error-box">{run.error_message}</div>
          )}
          <div
            ref={outputRef}
            className="terminal-output"
            role="log"
            aria-label="Execution logs"
            aria-live="off"
          >
            {loading ? (
              <div className="terminal-empty">
                <LoaderCircle className="spin" size={20} /> Loading execution
                output…
              </div>
            ) : visible.length ? (
              visible.map((entry, index) => (
                <div
                  className={`log-line ${entry.stream === "stderr" ? "log-stderr" : ""}`}
                  key={entry.id}
                >
                  <span className="line-number">{index + 1}</span>
                  <time>
                    {new Date(entry.timestamp).toLocaleTimeString([], {
                      hour12: false,
                    })}
                  </time>
                  <span className="log-stream">{entry.stream}</span>
                  <pre>{entry.message}</pre>
                </div>
              ))
            ) : (
              <div className="terminal-empty">
                <Radio size={23} />
                <p>
                  {["queued", "running"].includes(run.status)
                    ? "Waiting for output. New logs will appear here."
                    : "No output was recorded for this run."}
                </p>
              </div>
            )}
          </div>
          <div className="terminal-footer">
            <span>
              <span className={`tiny-dot ${streaming ? "green" : ""}`} />
              {streaming
                ? "Connected to live stream"
                : ["queued", "running"].includes(run.status)
                  ? "Checking for updates"
                  : "Run finished"}
            </span>
            <span>
              {run.exit_code != null
                ? `Exit code ${run.exit_code}`
                : dateTime(run.created_at)}
            </span>
          </div>
        </>
      ) : (
        <div className="terminal-output terminal-empty">
          <Terminal size={28} />
          <h4>Your logs, line by line.</h4>
          <p>
            Select a run to inspect its output.
            <br />
            Live runs stream here as they happen.
          </p>
        </div>
      )}
    </section>
  );
}
