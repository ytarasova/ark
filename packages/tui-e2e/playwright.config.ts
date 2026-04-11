import { defineConfig } from "@playwright/test";

/**
 * Ark TUI end-to-end Playwright config.
 *
 * Each test spins up its own TuiHarness (which owns a pty + a tiny
 * WebSocket server + an isolated ARK_DIR + an isolated TMUX_TMPDIR),
 * so Playwright workers are parallel-safe.
 *
 * Default: headless. Run `bun run test:headed` to watch the xterm
 * render live while iterating locally.
 */
export default defineConfig({
  testDir: "./tests",
  // Use `.pw.ts` (playwright) suffix so the bun test runner does NOT
  // also discover these files. Bun test matches *.test.ts, *.spec.ts,
  // *_test.ts, *_spec.ts by default, and `packages/tui` is a prefix
  // that would otherwise let bun sweep into `packages/tui-e2e/`.
  testMatch: "**/*.pw.ts",
  timeout: 60_000,
  globalTimeout: 300_000,
  retries: 0,
  // TUI tests own a pty each -- modest parallelism is fine.
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // The harness serves its own HTTP on an ephemeral port per test;
    // tests set baseURL themselves via harness.pageUrl.
  },
});
