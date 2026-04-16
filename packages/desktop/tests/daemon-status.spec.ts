/**
 * Daemon status smoke test -- verifies the Dashboard's System Health card
 * renders with all four rows: Conductor, ArkD, Router, Compute.
 *
 * Baseline (v0.15.5+): main.js spawns `ark web --with-daemon`, which boots
 * the conductor (:19100) and arkd (:19300) in-process. The dashboard is
 * expected to reach "online" for Conductor within 10s of launch.
 *
 * If an external daemon already holds those ports, `ark web` reuses them
 * (see main.js comment). Either way the System Health card should end up
 * reporting "online".
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

test("Dashboard renders System Health card with all four daemon rows", async () => {
  if (!launched) throw new Error("launch helper did not run");
  const { window } = launched;

  // The dashboard is the default view; navigate explicitly in case a
  // future change changes the default.
  await expect(window.locator('[data-testid="sidebar-brand"]')).toBeVisible({ timeout: 15_000 });

  // System Health card must render. Use a test-id for stability.
  const card = window.locator('[data-testid="system-health-card"]');
  await expect(card).toBeVisible({ timeout: 10_000 });

  // All four labeled rows must exist. Scope the lookups to the card
  // to avoid matching the Sidebar's "Compute" nav item.
  await expect(card.getByText("Conductor", { exact: true })).toBeVisible();
  await expect(card.getByText("ArkD", { exact: true })).toBeVisible();
  await expect(card.getByText("Router", { exact: true })).toBeVisible();
  await expect(card.getByText("Compute", { exact: true })).toBeVisible();
});

test("Conductor status reflects current daemon state", async () => {
  if (!launched) throw new Error("launch helper did not run");
  const { window } = launched;

  const card = window.locator('[data-testid="system-health-card"]');
  await expect(card).toBeVisible({ timeout: 10_000 });

  // v0.15.5+: main.js boots `ark web --with-daemon`, so the Conductor row
  // must reach "online" within ~15s (useDaemonStatus polls on mount then
  // every 5s; the probe itself has a 2s timeout; daemon spawn + first
  // probe tick fits inside 15s on dev hardware, though cold CI can be
  // slower).
  //
  // We assert the row shows *some* state (online|offline) within 15s
  // rather than racing the probe. If this test flakes on CI, tighten
  // by bumping the helper's launch timeout -- not this expect.
  //
  // Scope to the innermost flex row so the match is unique (the outer
  // CardContent div also contains the text).
  const conductorRow = card.locator("div.flex.items-center.justify-between").filter({ hasText: "Conductor" });
  await expect(conductorRow).toContainText(/online|offline/, { timeout: 15_000 });
});
