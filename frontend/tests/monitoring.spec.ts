import { expect, test } from "@playwright/test";
import { scheduledJobs, untilNext } from "../lib/monitoring";
import type { Job, Run, Schedule } from "../lib/types";

const job = { id: "job-1", name: "Daily report", enabled: true } as Job;
const schedule = {
  id: "schedule-1",
  job_id: job.id,
  type: "interval",
  enabled: true,
  next_run_at: "2026-10-22T12:00:00Z",
} as Schedule;

test("monitor model ignores manual runs and groups multiple schedules by job", () => {
  const automatic = {
    id: "automatic",
    job_id: job.id,
    trigger_type: "schedule",
    status: "failed",
    created_at: "2026-10-21T10:00:00Z",
  } as Run;
  const manual = {
    ...automatic,
    id: "manual",
    trigger_type: "manual",
    status: "success",
    created_at: "2026-10-21T11:00:00Z",
  };
  const second = {
    ...schedule,
    id: "schedule-2",
    next_run_at: "2026-10-22T11:00:00Z",
  };
  const [row] = scheduledJobs([job], [schedule, second], [manual, automatic]);
  expect(row.latestRun?.id).toBe("automatic");
  expect(row.needsAttention).toBe(true);
  expect(row.nextRun).toBe(second.next_run_at);
  expect(row.schedules).toHaveLength(2);
});

test("monitor model distinguishes inactive scheduling from an execution result", () => {
  const [row] = scheduledJobs(
    [job],
    [{ ...schedule, type: "once", enabled: false, next_run_at: undefined }],
    [],
  );
  expect(row.nextRun).toBeUndefined();
  expect(row.latestRun).toBeUndefined();
  expect(row.needsAttention).toBe(false);
  expect(
    scheduledJobs([{ ...job, enabled: false }], [schedule], [])[0].nextRun,
  ).toBeUndefined();
  expect(
    untilNext("2026-10-22T12:00:00Z", Date.parse("2026-10-22T12:00:01Z")),
  ).toBe("Due · awaiting scheduler");
});

test("monitoring is read-only and opens logs for the automatic execution", async ({
  page,
  request,
}) => {
  await request.get("http://127.0.0.1:8099/__reset");
  await page.goto("/");
  await page.getByLabel("Admin email").fill("admin@test.example");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace overview" }),
  ).toBeVisible();
  await expect(page.getByText("Loading your scheduler…")).toBeHidden();
  const id = "10000000-0000-4000-8000-000000000001";
  await page.request.post(`/api/backend/jobs/${id}/schedules`, {
    data: {
      type: "interval",
      interval_seconds: 300,
      enabled: true,
      timezone: "UTC",
    },
  });
  const automatic = {
    id: "20000000-0000-4000-8000-000000000001",
    job_id: id,
    status: "failed",
    trigger_type: "schedule",
    created_at: "2026-10-21T10:00:00Z",
    started_at: "2026-10-21T10:00:00Z",
    finished_at: "2026-10-21T10:00:02Z",
    exit_code: 1,
    error_message: "Report failed",
  };
  await page.route(`**/api/backend/jobs/${id}/runs`, (route) =>
    route.fulfill({
      json: [
        {
          ...automatic,
          id: "manual-run",
          status: "success",
          trigger_type: "manual",
          created_at: "2026-10-21T11:00:00Z",
        },
        automatic,
      ],
    }),
  );
  await page.getByRole("button", { name: "Monitoring", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Monitoring", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Read-only monitoring", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Exit code 1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Create job|New schedule|Edit schedule|Pause schedule|Run job|Delete schedule/,
    }),
  ).toHaveCount(0);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/backend/") && request.method() !== "GET")
      mutations.push(request.url());
  });
  await page.getByLabel("Filter monitored jobs").selectOption("attention");
  await expect(page.getByRole("button", { name: "View logs" })).toBeVisible();
  await page.getByLabel("Filter monitored jobs").selectOption("waiting");
  await expect(
    page.getByRole("heading", { name: "No jobs match this view." }),
  ).toBeVisible();
  await page.getByLabel("Filter monitored jobs").selectOption("all");
  await page.getByLabel("Search monitored jobs").fill("Inventory");
  await page.getByText("1 schedule", { exact: true }).click();
  await expect(page.getByText("Every 300s", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View logs", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Live logs", exact: true }),
  ).toBeVisible();
  expect(mutations).toEqual([]);
});

test("scheduled Run now opens logs and preserves automatic timing", async ({
  page,
  request,
}) => {
  await request.get("http://127.0.0.1:8099/__reset");
  await page.goto("/");
  await page.getByLabel("Admin email").fill("admin@test.example");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace overview" }),
  ).toBeVisible();
  await expect(page.getByText("Loading your scheduler…")).toBeHidden();
  const id = "10000000-0000-4000-8000-000000000001";
  const response = await page.request.post(
    `/api/backend/jobs/${id}/schedules`,
    {
      data: {
        type: "interval",
        interval_seconds: 300,
        enabled: true,
        timezone: "UTC",
      },
    },
  );
  expect(response.ok()).toBe(true);
  const original = await response.json();
  await page.getByRole("button", { name: "Schedules", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Enabled schedules run automatically.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Live logs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("LIVE OUTPUT ARRIVED", { exact: true }),
  ).toBeVisible();
  const after = await (
    await page.request.get(`/api/backend/jobs/${id}/schedules`)
  ).json();
  expect(after[0].next_run_at).toBe(original.next_run_at);
  expect(after[0].enabled).toBe(true);
  const runs = await (
    await page.request.get(`/api/backend/jobs/${id}/runs`)
  ).json();
  expect(runs[0].trigger_type).toBe("manual");
});
