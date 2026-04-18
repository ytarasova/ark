import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./web",
  // Per-test wall-clock cap. Also governs beforeAll/afterAll hooks in
  // Playwright (there is no separate hookTimeout). 60s is enough for a test
  // + its share of setupWebServer; the fixture now caps its own teardown at
  // 20s so afterAll cannot consume the whole 60s budget even on a hang.
  timeout: 60_000,
  // Default expect() assertion timeout. The Playwright default of 5s trips
  // on cold CI where first-paint after a reload can take 6-8s. 10s keeps
  // the short-circuit for real regressions but absorbs the common slow-paint
  // flake. Individual assertions still pass explicit timeouts.
  expect: { timeout: 10_000 },
  // Run budget for the whole test run. Previously 300s, which was less than
  // the time it takes for 19 specs x (build + spawn + tests + teardown) to
  // complete sequentially on cold CI. 900s matches the CI job's 15min cap
  // and lets slow runs finish instead of cascading into "did not run".
  globalTimeout: 900_000,
  // Full suite occasionally trips on resource pressure (each spec
  // spawns its own `ark web` subprocess; SIGKILL surfaces when many
  // spawn in sequence). Retries absorb the transient flake without
  // hiding logic bugs -- a consistent failure still surfaces on retry.
  retries: 2,
  workers: 1,
  reporter: "list",
  // Sweep any leftover orphan `ark web` processes (PPID=1, reparented to
  // launchd/init) after the whole run. Last line of defense behind the
  // per-worker reap hooks and the child-side ARK_WATCH_PARENT watchdog.
  globalTeardown: "./fixtures/global-teardown.ts",
  use: {
    trace: "on-first-retry",
    // Default per-action (click/fill/...) timeout. The global default is
    // 0 (no timeout), which lets a hung action wedge the whole test.
    actionTimeout: 15_000,
    // Default navigation (goto/reload) timeout. Page reloads after DB mutation
    // on cold CI can take 10-15s for the Vite-built bundle to re-render, so
    // 30s gives comfortable headroom over the most common flake path.
    navigationTimeout: 30_000,
  },
});
