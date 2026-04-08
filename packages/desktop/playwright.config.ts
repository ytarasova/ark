import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  globalTimeout: 120_000,
  retries: 0,
  workers: 1, // Electron tests must be sequential
  reporter: "list",
  use: {
    trace: "on-first-retry",
  },
});
