/**
 * Daemon status smoke test -- verifies the IconRail renders a daemon-status
 * dot on the sidebar brand tile and that it reaches a terminal state
 * (online | partial | offline) once the probe has run.
 *
 * The previous "System Health" card on the Dashboard was removed in the
 * web session-view overhaul. Daemon health is now surfaced only as a
 * colored dot on the sidebar brand in `packages/web/src/components/ui/
 * IconRail.tsx`, with `data-testid="daemon-status-dot"` and a
 * `data-status` attribute carrying `loading | online | partial | offline`.
 *
 * Baseline (v0.15.5+): main.js spawns `ark web --with-daemon`, which boots
 * the conductor (:19100) and arkd (:19300) in-process. The dot is expected
 * to reach "online" within ~15s of launch. If an external daemon already
 * holds those ports, `ark web` reuses them (see main.js comment). Either
 * way the dot should end up non-"loading".
 */

import { test, expect } from "@playwright/test";
import { launchArk, closeArk, type LaunchedArk } from "./helpers/electron.js";

let launched: LaunchedArk | undefined;

test.beforeEach(async () => {
  launched = await launchArk();
});

test.afterEach(async () => {
  await closeArk(launched);
  launched = undefined;
});

test("IconRail renders the daemon-status dot on the sidebar brand", async () => {
  if (!launched) throw new Error("launch helper did not run");
  const { window } = launched;

  // Sidebar brand proves the SPA mounted.
  await expect(window.locator('[data-testid="sidebar-brand"]')).toBeVisible({ timeout: 15_000 });

  // The dot is rendered as a sibling span inside the same relative
  // container as the brand tile. Use the test-id for stability.
  const dot = window.locator('[data-testid="daemon-status-dot"]');
  await expect(dot).toBeVisible({ timeout: 10_000 });
});

test("daemon-status dot reflects current daemon state", async () => {
  if (!launched) throw new Error("launch helper did not run");
  const { window } = launched;

  const dot = window.locator('[data-testid="daemon-status-dot"]');
  await expect(dot).toBeVisible({ timeout: 10_000 });

  // v0.15.5+: main.js boots `ark web --with-daemon`, so the dot must
  // reach a terminal state (online|partial|offline, i.e. not "loading")
  // within ~15s. useDaemonStatus polls on mount then every 15s; the
  // probe itself has a short timeout; first probe tick + daemon spawn
  // fits inside 15s on dev hardware, though cold CI can be slower.
  //
  // We assert the `data-status` attribute is one of the terminal values
  // rather than racing the probe. If this flakes on CI, tighten by
  // bumping the helper's launch timeout -- not this expect.
  await expect(dot).toHaveAttribute("data-status", /online|partial|offline/, { timeout: 15_000 });
});
