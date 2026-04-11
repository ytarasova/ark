import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./web",
  timeout: 60_000,
  globalTimeout: 300_000,
  // Full suite occasionally trips on resource pressure (each spec
  // spawns its own `ark web` subprocess; SIGKILL surfaces when many
  // spawn in sequence). Retries absorb the transient flake without
  // hiding logic bugs -- a consistent failure still surfaces on retry.
  retries: 2,
  workers: 1,
  reporter: "list",
  use: {
    trace: "on-first-retry",
  },
});
