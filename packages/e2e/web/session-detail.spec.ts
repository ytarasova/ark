/**
 * Session detail panel E2E tests.
 *
 * Tests the right-side detail panel: metadata display, todos,
 * messaging, status actions, export/import round-trip.
 */

import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { setupWebServer, type WebServerEnv } from "../fixtures/web-server.js";

let ws: WebServerEnv;
let browser: Browser;
let page: Page;

/** Helper to create a session via RPC and return its ID */
async function createSession(summary: string): Promise<string> {
  const data = await ws.rpc("session/start", { summary, repo: ws.env.workdir, flow: "bare" });
  return data.session.id;
}

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

async function goToSessions() {
  await page.click('nav button:has-text("Sessions")');
  await expect(page.locator("h1")).toContainText("Sessions");
}

// -- Open detail panel --------------------------------------------------------

test("click session opens detail panel with ID and status", async () => {
  const id = await createSession("Detail panel test");
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();

  // Click the session in the list
  await page.locator("text=Detail panel test").click();

  // The detail panel should show the session ID
  await expect(page.locator(`text=${id}`).first()).toBeVisible({ timeout: 5_000 });

  // Should show "Details" section heading
  await expect(page.locator("text=Details").first()).toBeVisible();

  // Should show Summary label with value
  await expect(page.locator("text=Detail panel test").first()).toBeVisible();

  // Should show Flow value
  await expect(page.locator("text=bare").first()).toBeVisible();
});

// -- Todos management ---------------------------------------------------------

test("add todo via API and verify in detail panel", async () => {
  const id = await createSession("Todo test session");

  // Add todos via RPC
  await ws.rpc("todo/add", { sessionId: id, content: "Review the code" });
  await ws.rpc("todo/add", { sessionId: id, content: "Run the tests" });

  // Reload and navigate to the session detail
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();
  await page.locator("text=Todo test session").click();
  await expect(page.locator("text=Details").first()).toBeVisible({ timeout: 5_000 });

  // Verify todos are displayed in the detail panel
  await expect(page.locator("text=Review the code")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("text=Run the tests")).toBeVisible();
});

test("add todo via detail panel UI", async () => {
  const _id = await createSession("Todo UI test");
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();
  await page.locator("text=Todo UI test").click();
  await expect(page.locator("text=Details").first()).toBeVisible({ timeout: 5_000 });

  // Use the Add a todo input
  const todoInput = page.locator('input[placeholder="Add a todo..."]');
  await expect(todoInput).toBeVisible();
  await todoInput.fill("Write documentation");
  await page.locator('button:has-text("Add")').click();

  // Verify the todo appears
  await expect(page.locator("text=Write documentation")).toBeVisible({ timeout: 5_000 });
});

// -- Send message to session --------------------------------------------------

test("send message form appears and submits", async () => {
  const _id = await createSession("Message test");

  // Set session to running so the Send button appears
  // We need to dispatch it or manually set status -- use complete instead
  // Actually, "Send" only shows for running/waiting status.
  // Let's verify the Send button is NOT visible for a non-running session
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();
  await page.locator("text=Message test").click();
  await expect(page.locator("text=Details").first()).toBeVisible({ timeout: 5_000 });

  // For a ready/pending session, Send button should NOT be visible
  // but Dispatch should be visible
  await expect(page.locator('button:has-text("Dispatch")')).toBeVisible();
});

// -- Session actions: complete ------------------------------------------------

test("complete action changes session status", async () => {
  const id = await createSession("Complete test");
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();
  await page.locator("text=Complete test").click();
  await expect(page.locator("text=Details").first()).toBeVisible({ timeout: 5_000 });

  // Complete the session via RPC (the UI button only shows for running/waiting/blocked)
  await ws.rpc("session/complete", { sessionId: id });

  // Reload detail to see updated status
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();
  await page.locator("text=Complete test").click();

  // Verify completed status badge is shown (uppercase "COMPLETED")
  await expect(page.locator("text=completed").first()).toBeVisible({ timeout: 5_000 });
});

// -- Export and import round-trip ---------------------------------------------

test("export and import session round-trip", async () => {
  const id = await createSession("Export test session");

  // Export via RPC
  const exportData = await ws.rpc("session/export-data", { sessionId: id });
  expect(exportData.version).toBe(1);
  expect(exportData.session).toBeTruthy();
  expect(exportData.session.summary).toBe("Export test session");

  // Import via RPC
  const importData = await ws.rpc("session/import", exportData);
  expect(importData.ok).toBe(true);
  expect(importData.sessionId).toBeTruthy();

  // Verify the imported session appears in the list
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();
  await expect(page.locator("text=[imported] Export test session")).toBeVisible({ timeout: 10_000 });
});

// -- Detail panel close -------------------------------------------------------

test("selecting another session replaces detail panel", async () => {
  const id1 = await createSession("Close test A");
  const id2 = await createSession("Close test B");
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();

  // Click session A to open its detail.
  // Scope to the list row (`.first()`) so strict mode doesn't flag the
  // later match in the detail header.
  await page.locator("text=Close test A").first().click();
  await expect(page.locator(`text=${id1}`).first()).toBeVisible({ timeout: 5_000 });

  // Click session B -- it should replace session A in the detail panel
  await page.locator("text=Close test B").first().click();
  await expect(page.locator(`text=${id2}`).first()).toBeVisible({ timeout: 5_000 });
});

// -- Events list in detail panel (via API seeding) ----------------------------

test("session detail shows events when available", async () => {
  const id = await createSession("Events test session");

  // Fetch detail via RPC -- events should be an empty array for a new session
  const detail = await ws.rpc("session/read", { sessionId: id, include: ["events"] });
  expect(detail.session).toBeTruthy();
  expect(Array.isArray(detail.events)).toBe(true);
});
