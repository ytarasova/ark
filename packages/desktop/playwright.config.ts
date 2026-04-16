import { defineConfig } from "@playwright/test";

/**
 * Playwright config for Ark Desktop Electron smoke tests.
 *
 * These tests launch the real Electron app (packaged mode uses electron-builder
 * artifacts; dev mode launches `electron .` via playwright's _electron helper)
 * and drive the embedded BrowserWindow with a Chromium DevTools Protocol
 * connection.
 *
 * Run with `npm test` from this directory, or `bun run --filter desktop test`
 * from the repo root.
 */
export default defineConfig({
  testDir: "./tests",
  // Each Electron launch takes 5-15s on a cold boot (spawning the `ark web`
  // subprocess + waiting for the HTTP server). Linux under xvfb in CI
  // pushes this up to ~10-20s, and we need headroom for a bounded teardown
  // (~5s more) inside the same budget. 60s is generous but keeps a hung
  // test from wedging the worker indefinitely.
  timeout: 60_000,
  // Cap the whole run so a hung Electron process cannot wedge CI forever.
  globalTimeout: 300_000,
  // Electron can flake when a port collides with a pre-existing ark daemon
  // (conductor :19100, arkd :19300). ARK_TEST_DIR isolates the DB but ports
  // are per-host; a single retry absorbs these transient collisions without
  // masking real failures.
  retries: 1,
  // Tests share the same temp-dir naming scheme; running in parallel would
  // race on the ARK_TEST_DIR root. Sequential execution is correctness first.
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    // Screenshots + traces on failure only -- keep green-run artifacts small.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  // Keep a per-run output dir so CI can upload artifacts cleanly.
  outputDir: "test-results",
});
