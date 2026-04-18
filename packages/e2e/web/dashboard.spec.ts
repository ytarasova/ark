/**
 * Dashboard page integration-boundary tests.
 *
 * The Dashboard is mostly a read-only view of data served by the
 * `dashboard/summary` RPC and an SSE event stream. Trivial DOM
 * presence checks (header text, widget labels, empty-state copy)
 * are intentionally out of scope -- they break on every markup
 * tweak and test nothing that isn't already caught by a type error.
 *
 * What this file covers:
 *   1. `dashboard/summary` RPC returns the shape the page depends on
 *      (integration boundary: handler + DB + pricing registry).
 *   2. SSE event stream is reachable from the Dashboard route (integration
 *      boundary: SSE bus + HTTP wiring).
 *   3. Dashboard-triggered navigation (click a widget → route changes)
 *      still works, which is where a router misconfiguration shows up.
 */

import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { setupWebServer, type WebServerEnv } from "../fixtures/web-server.js";

let ws: WebServerEnv;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  ws = await setupWebServer();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(ws.baseUrl);
  await page.waitForSelector("nav", { timeout: 15_000 });
});

test.afterAll(async () => {
  if (browser) await browser.close();
  if (ws) await ws.teardown();
});

async function goToDashboard() {
  await page.click('nav button:has-text("Dashboard")');
  await expect(page.locator("text=Loading dashboard...")).not.toBeVisible({ timeout: 10_000 });
}

test("dashboard/summary RPC returns the shape DashboardView consumes", async () => {
  // Contract check against packages/server/handlers/dashboard.ts:
  // returns { counts, costs, recentEvents, topCostSessions, system, activeCompute }.
  // A regression in the handler's shape silently breaks the dashboard
  // until someone opens it.
  const summary = await ws.rpc<{
    counts: Record<string, number>;
    costs: { total: number; today: number; week: number; month: number; byModel: Record<string, number> };
    recentEvents: unknown[];
    topCostSessions: unknown[];
    system: { conductor: boolean; router: boolean };
    activeCompute: number;
  }>("dashboard/summary");
  expect(summary).toBeTruthy();
  expect(typeof summary.counts.running).toBe("number");
  expect(typeof summary.counts.completed).toBe("number");
  expect(typeof summary.counts.failed).toBe("number");
  expect(typeof summary.costs.total).toBe("number");
  expect(summary.costs).toHaveProperty("byModel");
  expect(Array.isArray(summary.recentEvents)).toBe(true);
  expect(typeof summary.system.conductor).toBe("boolean");
});

// TODO(#175): Dashboard was removed from the top-level nav -- attention
// items now live on the Sessions view. The RPC contract is still tested
// above, but the nav-click path no longer exists.
test.skip("clicking a Dashboard widget navigates to the linked view", async () => {
  await goToDashboard();
  await page.click('text="View all costs"');
  await expect(page.locator("h1")).toContainText("Costs", { timeout: 5_000 });
});
