/**
 * Navigation & API health E2E tests.
 *
 * Tests sidebar rendering, tab switching, SSE connection,
 * and core API endpoint health.
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

// -- Sidebar rendering -------------------------------------------------------

test("sidebar renders all 9 navigation items", async () => {
  const navButtons = page.locator("nav button");
  await expect(navButtons).toHaveCount(9);
});

test("sidebar shows ark brand text", async () => {
  await expect(page.locator("text=ark").first()).toBeVisible();
});

test("sidebar nav items have correct labels", async () => {
  const expected = [
    "Sessions", "Agents", "Flows", "Compute", "History",
    "Memory", "Tools", "Schedules", "Costs",
  ];
  for (const label of expected) {
    await expect(page.locator(`nav button:has-text("${label}")`)).toBeVisible();
  }
});

// -- Tab switching ------------------------------------------------------------

test("sessions view is shown by default", async () => {
  // Navigate back to Sessions first in case previous tests changed the view
  await page.click('nav button:has-text("Sessions")');
  await expect(page.locator("h1")).toContainText("Sessions");
});

test("click Agents tab navigates to agents page", async () => {
  await page.click('nav button:has-text("Agents")');
  await expect(page.locator("h1")).toContainText("Agents");
});

test("click Tools tab navigates to tools page", async () => {
  await page.click('nav button:has-text("Tools")');
  await expect(page.locator("h1")).toContainText("Tools");
});

test("click Flows tab navigates to flows page", async () => {
  await page.click('nav button:has-text("Flows")');
  await expect(page.locator("h1")).toContainText("Flows");
});

test("click History tab navigates to history page", async () => {
  await page.click('nav button:has-text("History")');
  await expect(page.locator("h1")).toContainText("History");
});

test("click Compute tab navigates to compute page", async () => {
  await page.click('nav button:has-text("Compute")');
  await expect(page.locator("h1")).toContainText("Compute");
});

test("click Schedules tab navigates to schedules page", async () => {
  await page.click('nav button:has-text("Schedules")');
  await expect(page.locator("h1")).toContainText("Schedules");
});

test("click Memory tab navigates to memory page", async () => {
  await page.click('nav button:has-text("Memory")');
  await expect(page.locator("h1")).toContainText("Memory");
});

test("click Costs tab navigates to costs page", async () => {
  await page.click('nav button:has-text("Costs")');
  await expect(page.locator("h1")).toContainText("Costs");
});

test("click Sessions tab returns to sessions page", async () => {
  await page.click('nav button:has-text("Sessions")');
  await expect(page.locator("h1")).toContainText("Sessions");
});

// -- SSE event stream ---------------------------------------------------------

test("SSE event stream connects successfully", async () => {
  const connected = await page.evaluate((baseUrl) => {
    return new Promise<boolean>((resolve) => {
      const es = new EventSource(`${baseUrl}/api/events/stream`);
      es.onopen = () => { es.close(); resolve(true); };
      es.onerror = () => { es.close(); resolve(false); };
      setTimeout(() => { es.close(); resolve(false); }, 5000);
    });
  }, ws.baseUrl);
  expect(connected).toBe(true);
});

// -- API endpoint health ------------------------------------------------------

test("GET /api/status responds with session totals", async () => {
  const res = await fetch(`${ws.baseUrl}/api/status`);
  expect(res.ok).toBe(true);
  const data = await res.json();
  expect(data).toHaveProperty("total");
  expect(data).toHaveProperty("byStatus");
});

test("GET /api/sessions responds with array", async () => {
  const res = await fetch(`${ws.baseUrl}/api/sessions`);
  expect(res.ok).toBe(true);
  const data = await res.json();
  expect(Array.isArray(data)).toBe(true);
});

test("GET /api/agents responds with non-empty array", async () => {
  const res = await fetch(`${ws.baseUrl}/api/agents`);
  expect(res.ok).toBe(true);
  const data = await res.json();
  expect(Array.isArray(data)).toBe(true);
  expect(data.length).toBeGreaterThan(0);
});

test("GET /api/flows responds with non-empty array", async () => {
  const res = await fetch(`${ws.baseUrl}/api/flows`);
  expect(res.ok).toBe(true);
  const data = await res.json();
  expect(Array.isArray(data)).toBe(true);
  expect(data.length).toBeGreaterThan(0);
});

test("GET /api/compute responds with array", async () => {
  const res = await fetch(`${ws.baseUrl}/api/compute`);
  expect(res.ok).toBe(true);
  const data = await res.json();
  expect(Array.isArray(data)).toBe(true);
});
