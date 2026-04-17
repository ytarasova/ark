import { defineConfig } from "@playwright/test";

/**
 * Playwright config for web e2e tests.
 *
 * Assumes the dev server is already running on localhost:5173
 * (start it with `make dev` before running these tests).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  globalTimeout: 180_000,
  retries: 1,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
});
