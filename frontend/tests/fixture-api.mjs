// Isolated test data. Never connects to the real scheduler or runs containers.
import http from "node:http";
const jobId = "10000000-0000-4000-8000-000000000001";
const runId = "20000000-0000-4000-8000-000000000001";
let jobs, runs, schedules;
const now = () => new Date().toISOString();
function reset() {
  jobs = [
    {
      id: jobId,
      name: "Inventory sync",
      description: "Fixture Python job",
      script_type: "python",
      script_path: "/scripts/sync.py",
      args: [],
      env: {},
      working_dir: "/scripts",
      timeout_seconds: 300,
      enabled: true,
      created_at: now(),
    },
  ];
  runs = [
    {
      id: runId,
      job_id: jobId,
      status: "success",
      trigger_type: "manual",
      started_at: now(),
      finished_at: now(),
      exit_code: 0,
      created_at: now(),
    },
  ];
  schedules = [];
}
reset();
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:8099");
  const path = url.pathname;
  const send = (status, value) => {
    response.writeHead(status, {
      "Content-Type":
        typeof value === "string" ? "text/plain" : "application/json",
    });
    response.end(typeof value === "string" ? value : JSON.stringify(value));
  };
  if (path === "/health" || path === "/ready") return send(200, "ok");
  if (path === "/__reset") {
    reset();
    return send(200, {});
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = body ? JSON.parse(body) : {};
  if (path === "/api/auth/login")
    return input.email === "admin@test.example" &&
      input.password === "test-password"
      ? send(200, { token: "fixture-admin-token" })
      : send(401, "invalid email or password");
  if (request.headers.authorization !== "Bearer fixture-admin-token")
    return send(401, "authentication required");
  if (path === "/api/auth/me")
    return send(200, {
      id: "fixture-admin",
      email: "admin@test.example",
      role: "admin",
    });
  if (path === "/api/jobs" && request.method === "GET") return send(200, jobs);
  if (path === "/api/jobs" && request.method === "POST") {
    const job = { ...input, id: crypto.randomUUID(), created_at: now() };
    jobs.unshift(job);
    return send(201, job);
  }
  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)\/(runs|run|schedules)$/);
  if (jobMatch) {
    const [, id, resource] = jobMatch;
    if (resource === "runs")
      return send(
        200,
        runs.filter((run) => run.job_id === id),
      );
    if (resource === "run") {
      const run = {
        id: crypto.randomUUID(),
        job_id: id,
        status: "queued",
        trigger_type: "manual",
        created_at: now(),
      };
      runs.unshift(run);
      return send(202, run);
    }
    if (request.method === "GET")
      return send(
        200,
        schedules.filter((schedule) => schedule.job_id === id),
      );
    const schedule = {
      ...input,
      id: crypto.randomUUID(),
      job_id: id,
      next_run_at: new Date(Date.now() + 3600000).toISOString(),
      created_at: now(),
    };
    schedules.push(schedule);
    return send(201, schedule);
  }
  const scheduleMatch = path.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleMatch) {
    const index = schedules.findIndex(
      (schedule) => schedule.id === scheduleMatch[1],
    );
    if (index < 0) return send(404, "schedule not found");
    if (request.method === "DELETE") {
      schedules.splice(index, 1);
      response.writeHead(204);
      return response.end();
    }
    schedules[index] = { ...schedules[index], ...input };
    return send(200, schedules[index]);
  }
  const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/logs(?:\/stream)?)?$/);
  if (runMatch) {
    const run = runs.find((item) => item.id === runMatch[1]);
    if (!run) return send(404, "run not found");
    if (!runMatch[2]) return send(200, run);
    if (runMatch[2].endsWith("stream")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (run.id !== runId) {
        run.status = "success";
        run.started_at = now();
        run.finished_at = now();
        run.exit_code = 0;
        const entry = {
          id: 1,
          run_id: run.id,
          timestamp: now(),
          stream: "stdout",
          message: "LIVE OUTPUT ARRIVED",
        };
        response.write(`id: 1\ndata: ${JSON.stringify(entry)}\n\n`);
      }
      return response.end('event: done\ndata: "success"\n\n');
    }
    const after = Number(url.searchParams.get("after") || 0);
    const limit = Number(url.searchParams.get("limit") || 200);
    const logs =
      run.id === runId
        ? Array.from({ length: 1205 }, (_, index) => ({
            id: index + 1,
            run_id: run.id,
            timestamp: now(),
            stream: index === 1204 ? "stderr" : "stdout",
            message:
              index === 1204 ? "FINAL LOG LINE" : `Output line ${index + 1}`,
          }))
            .filter((entry) => entry.id > after)
            .slice(0, limit)
        : [];
    return send(200, logs);
  }
  return send(404, "not found");
});
server.listen(8099, "127.0.0.1");
