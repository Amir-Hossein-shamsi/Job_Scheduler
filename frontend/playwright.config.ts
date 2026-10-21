import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chromium" },
    },
  ],
  webServer: [
    {
      command: "node tests/fixture-api.mjs",
      url: "http://127.0.0.1:8099/health",
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100",
      env: { BACKEND_URL: "http://127.0.0.1:8099", TASKFLOW_TEST_MODE: "1" },
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
