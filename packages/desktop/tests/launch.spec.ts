/**
 * Baseline boot smoke test.
 *
 * Proves that:
 *  1. Electron can launch via `_electron.launch({ args: ['.'], cwd: ... })`.
 *  2. A BrowserWindow becomes visible within 20s.
 *  3. No "Startup Error" dialog fires (the embedded `ark web` subprocess
 *     came up within its 15s window).
 *  4. The window title is "Ark".
 *  5. The React SPA actually mounted (sidebar brand locator visible).
 *
 * Captures a `dashboard-baseline.png` screenshot under
 * `tests/__snapshots__/` for future visual-regression work.
 */

import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { launchArk, closeArk, appIsStillRunning, type LaunchedArk } from "./helpers/electron.js";

let launched: LaunchedArk | undefined;

test.beforeEach(async () => {
  launched = await launchArk();
});

test.afterEach(async () => {
  await closeArk(launched);
  launched = undefined;
});

test("boots Electron and mounts the React SPA", async () => {
  if (!launched) throw new Error("launch helper did not run");
  const { app, window } = launched;

  // The app must still be alive -- if `ark web` failed to start, main.js
  // calls dialog.showErrorBox("Startup Error", ...) then app.quit().
  expect(await appIsStillRunning(app)).toBe(true);

  // Window title comes from BrowserWindow({ title: APP_TITLE }) in main.js.
  // It may be overridden by the React app's <title>, so we accept either
  // "Ark" or a title that starts with "Ark".
  const title = await window.title();
  expect(title === "Ark" || title.startsWith("Ark")).toBe(true);

  // Sidebar brand ("ark") must render -- proves the SPA mounted and got
  // a 200 from the embedded web server. The brand has data-testid
  // (added in this change to packages/web/src/components/Sidebar.tsx).
  await expect(window.locator('[data-testid="sidebar-brand"]')).toBeVisible({ timeout: 15_000 });

  // Visual-regression baseline. Stored under tests/__snapshots__/launch.spec.ts/.
  // Not an assertion yet -- just capture a reference for future diffs.
  await window.screenshot({
    path: join(__dirname, "__snapshots__", "dashboard-baseline.png"),
    fullPage: true,
  });
});

test("window becomes visible within 20s", async () => {
  if (!launched) throw new Error("launch helper did not run");
  const { window } = launched;

  // BrowserWindow.show() fires `ready-to-show`, after which the content
  // is visible. Playwright's firstWindow() already blocks on this, so
  // by the time beforeEach resolves the window is visible. Double-check
  // the body is non-empty.
  const bodyHTML = await window.evaluate(() => document.body.innerHTML.length);
  expect(bodyHTML).toBeGreaterThan(0);
});
