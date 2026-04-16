/**
 * Window chrome smoke test -- verifies the sidebar brand does not overlap
 * the macOS traffic-light buttons.
 *
 * main.js uses `titleBarStyle: "hiddenInset"` on macOS, which reserves
 * a ~28px strip at the top-left for the red/yellow/green buttons. The
 * drag-region CSS (packages/web/src/styles.css) adds `padding-top: 22px`
 * to body.is-macos so the brand sits below that strip.
 *
 * Regression this catches: v0.15.4 shipped with the brand overlapping
 * the traffic lights on macOS. v0.15.5 moves the brand down.
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

test("sidebar brand does not intersect macOS traffic-light zone", async () => {
  if (!launched) throw new Error("launch helper did not run");
  const { app, window } = launched;

  const platform = await app.evaluate(() => process.platform);
  test.skip(platform !== "darwin", "Traffic-light chrome is macOS-specific");

  const brand = window.locator('[data-testid="sidebar-brand"]');
  await expect(brand).toBeVisible({ timeout: 15_000 });

  const box = await brand.boundingBox();
  if (!box) throw new Error("sidebar-brand has no bounding box");

  // macOS traffic lights occupy roughly (0,0)-(80,30) under
  // `hiddenInset`: Electron positions them ~8-16px from the top-left,
  // three circles ~14px wide with ~8px gaps = ~70px total. The brand is
  // clear if it starts either below y=30 (the traffic-light row) OR to
  // the right of x=80 (past the third button). The v0.15.5 fix adds
  // padding-top:22px to body.is-macos .drag-region, which pushes the
  // brand to y ~22+.
  const clearOfTrafficLights = box.y >= 30 || box.x >= 80;
  expect(clearOfTrafficLights, `Brand box {x:${box.x}, y:${box.y}} overlaps traffic lights at (0,0)-(80,30)`).toBe(
    true,
  );
});
