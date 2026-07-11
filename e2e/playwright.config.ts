import { defineConfig, devices } from "@playwright/test";

// Playwright config for Castify e2e smoke tests.
//
// The test suite assumes the full application stack is already running
// (SPA + API on a single port). The `just e2e` recipe and the CI workflow
// handle the Docker lifecycle: cold boot → health gate → tests → teardown.
// To run manually against an already-running stack:
//
//   docker compose up --build -d   # or: cargo run --release
//   cd e2e && npx playwright test

const BASE_URL = process.env.CASTIFY_E2E_BASE_URL ?? "http://localhost:8427";

export default defineConfig({
  testDir: "./tests",
  // Single worker + no parallelism: the suite mutates shared state (the
  // database owner record) against one stack instance.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
