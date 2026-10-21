import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Admin email").fill("admin@test.example");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace overview" }),
  ).toBeVisible();
  await expect(page.getByText("Loading your scheduler…")).toBeHidden();
}

test.beforeEach(async ({ request }) => {
  await request.get("http://127.0.0.1:8099/__reset");
});

test("login errors, protected proxy, HTTP-only cookie and logout", async ({
  page,
  request,
}, testInfo) => {
  expect((await request.get("/api/backend/jobs")).status()).toBe(401);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("login.png"),
    fullPage: true,
  });
  await page.getByLabel("Admin email").fill("admin@test.example");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "invalid email or password",
  );
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  const response = page.waitForResponse("**/api/backend/auth/login");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  expect(await (await response).json()).toEqual({ authenticated: true });
  await expect(
    page.getByRole("heading", { name: "Workspace overview" }),
  ).toBeVisible();
  await expect(page.getByText("Loading your scheduler…")).toBeHidden();
  await page.screenshot({
    path: testInfo.outputPath("dashboard.png"),
    fullPage: true,
  });
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === "scheduler_session",
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "fixture-admin-token",
  );
  expect((await page.request.get("/api/backend/not-allowed")).status()).toBe(
    404,
  );
  expect(
    (
      await page.request.post("/api/backend/jobs", {
        headers: { Origin: "https://other.example" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  expect((await page.request.get("/api/backend/jobs")).status()).toBe(401);
});

test("create SQL job, run it, and manage its schedule", async ({ page }) => {
  await login(page);
  await page
    .getByRole("button", { name: "Create job", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Job name").fill("Sales report");
  await dialog.getByLabel("Script path").fill("/scripts/report.py");
  await dialog.getByLabel("Arguments").fill('{"invalid":true}');
  await dialog.getByRole("button", { name: "Create job", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "JSON array of strings",
  );
  await dialog.getByLabel("Runtime").selectOption("sql");
  await expect(dialog.getByLabel("Arguments")).toHaveCount(0);
  await expect(dialog.getByLabel("Environment")).toHaveCount(0);
  await dialog.getByLabel("Script path").fill("/scripts/report.sql");
  await dialog.getByLabel("Engine", { exact: true }).selectOption("sqlserver");
  await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue("1433");
  await dialog.getByLabel("Host", { exact: true }).fill("db.example.internal");
  await dialog.getByLabel("Database / service name").fill("sales");
  await dialog.getByLabel("Username", { exact: true }).fill("reporter");
  await dialog
    .getByLabel("Password", { exact: true })
    .fill("database-test-password");
  await dialog.getByRole("button", { name: "Create job", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page
    .getByRole("button", { name: "Jobs", exact: false })
    .filter({ hasText: "Jobs" })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Sales report" }),
  ).toBeVisible();
  const card = page.locator("article").filter({ hasText: "Sales report" });
  await card.getByRole("button", { name: "Run job" }).click();
  await expect(page.getByRole("status")).toContainText("added to the queue");
  await page.getByRole("button", { name: "Schedules", exact: true }).click();
  await page.getByRole("button", { name: "New schedule" }).click();
  await dialog
    .getByLabel("Job", { exact: true })
    .selectOption({ label: "Sales report" });
  await dialog.getByRole("button", { name: "Interval", exact: true }).click();
  await dialog.getByLabel("Repeat every (seconds)").fill("600");
  await dialog
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("cell", { name: "Every 600s" })).toBeVisible();
  await page.getByRole("button", { name: "Pause schedule" }).click();
  await expect(
    page.getByRole("button", { name: "Enable schedule" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit schedule" }).click();
  await dialog.getByLabel("Repeat every (seconds)").fill("900");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("cell", { name: "Every 900s" })).toBeVisible();
  await page.getByRole("button", { name: "Delete schedule" }).click();
  await dialog.getByRole("button", { name: "Delete schedule" }).click();
  await expect(
    page.getByRole("heading", { name: "Find your rhythm." }),
  ).toBeVisible();
});

test("completed logs paginate past 1000 lines, filter stderr, and download", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Live logs", exact: true }).click();
  await expect(page.getByText("1205 lines", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "stderr", exact: true }).click();
  await expect(page.getByText("FINAL LOG LINE", { exact: true })).toBeVisible();
  await expect(page.getByText("Output line 1", { exact: true })).toBeHidden();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download loaded logs" }).click();
  expect((await download).suggestedFilename()).toContain(".log");
  await page
    .getByRole("button", { name: "System status", exact: true })
    .click();
  await expect(page.getByText("healthy", { exact: true })).toHaveCount(2);
});

test("mobile navigation and dialogs fit a small screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("button", { name: "Jobs", exact: false })
    .filter({ hasText: "Jobs" })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Jobs", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create job", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("streamed output arrives and the run status updates", async ({ page }) => {
  await login(page);
  await page
    .getByRole("button", { name: "Jobs", exact: false })
    .filter({ hasText: "Jobs" })
    .first()
    .click();
  await page.getByRole("button", { name: "Run job", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("added to the queue");
  await page.getByRole("button", { name: "Live logs", exact: true }).click();
  await expect(
    page.getByText("LIVE OUTPUT ARRIVED", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Exit code 0", { exact: true })).toBeVisible();
});

test("cron and one-time schedule forms submit valid API payloads", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Schedules", exact: true }).click();
  await page.getByRole("button", { name: "New schedule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Cron expression").fill("*/5 * * * *");
  await dialog.getByLabel("Timezone").fill("Asia/Tehran");
  await dialog
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "*/5 * * * *", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New schedule" }).click();
  await dialog.getByRole("button", { name: "One time" }).click();
  const future = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
  await dialog.getByLabel("Run at (your local time)").fill(future);
  const saved = page.waitForRequest(
    (request) =>
      request.url().endsWith("/schedules") && request.method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  const payload = (await saved).postDataJSON();
  expect(payload.type).toBe("once");
  expect(payload.run_at).toMatch(/Z$/);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Edit schedule" })).toHaveCount(
    2,
  );
});
