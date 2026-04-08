/**
 * Session CRUD E2E tests.
 *
 * Tests session creation via UI modal, filtering by status chips,
 * searching by summary, delete/undelete, clone (fork), archive/restore.
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

// -- Helper: ensure Sessions tab is active ------------------------------------

async function goToSessions() {
  await page.click('nav button:has-text("Sessions")');
  await expect(page.locator("h1")).toContainText("Sessions");
}

// -- Session page elements ----------------------------------------------------

test("sessions page shows search input", async () => {
  await goToSessions();
  await expect(page.locator('input[placeholder*="Search"]')).toBeVisible();
});

test("sessions page shows filter chips", async () => {
  await expect(page.locator('button:has-text("All")')).toBeVisible();
  await expect(page.locator('button:has-text("Running")')).toBeVisible();
  await expect(page.locator('button:has-text("Stopped")')).toBeVisible();
  await expect(page.locator('button:has-text("Failed")')).toBeVisible();
  await expect(page.locator('button:has-text("Completed")')).toBeVisible();
});

test("sessions page shows New Session button", async () => {
  await expect(page.locator('button:has-text("New Session")')).toBeVisible();
});

// -- Create session via modal -------------------------------------------------

test("create session via New Session modal", async () => {
  await goToSessions();

  // Open the modal
  await page.click('button:has-text("New Session")');
  await expect(page.locator("text=New Session").first()).toBeVisible();

  // Fill in the summary field
  const summaryInput = page.locator('input[placeholder="What should the agent work on?"]');
  await expect(summaryInput).toBeVisible();
  await summaryInput.fill("E2E test session alpha");

  // Fill in the repo field
  const repoInput = page.locator('input[placeholder="/path/to/repo or ."]');
  await repoInput.fill(ws.env.workdir);

  // Submit the form
  await page.click('button:has-text("Create Session")');

  // Wait for modal to close and session to appear in the list
  await expect(page.locator("text=E2E test session alpha")).toBeVisible({ timeout: 10_000 });
});

// -- Create a second session for filtering tests ------------------------------

test("create second session for filtering", async () => {
  // Create via API for speed
  const res = await fetch(`${ws.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary: "E2E test session beta", repo: ws.env.workdir, flow: "bare" }),
  });
  expect(res.ok).toBe(true);
  const data = await res.json();
  expect(data.ok).toBe(true);

  // Refresh the page to see both sessions
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();
  await expect(page.locator("text=E2E test session beta")).toBeVisible({ timeout: 10_000 });
});

// -- Search sessions ----------------------------------------------------------

test("search filters sessions by summary text", async () => {
  await goToSessions();
  const searchInput = page.locator('input[placeholder*="Search"]');
  await searchInput.fill("alpha");

  // Alpha session should be visible
  await expect(page.locator("text=E2E test session alpha")).toBeVisible();
  // Beta session should be hidden
  await expect(page.locator("text=E2E test session beta")).not.toBeVisible();

  // Clear search
  await searchInput.fill("");
  await expect(page.locator("text=E2E test session beta")).toBeVisible();
});

// -- Filter by status chips ---------------------------------------------------

test("filter chips show only matching status sessions", async () => {
  await goToSessions();

  // Both sessions are in "pending" / "ready" status, click "Running" filter
  await page.click('button:has-text("Running")');

  // No sessions should match "running" filter -- we see the empty state or zero cards
  // The sessions we created are in ready/pending state, not running
  await expect(page.locator("text=E2E test session alpha")).not.toBeVisible({ timeout: 3_000 });

  // Click "All" to restore
  await page.click('button:has-text("All")');
  await expect(page.locator("text=E2E test session alpha")).toBeVisible();
});

// -- Delete and undelete session ----------------------------------------------

test("delete and undelete session", async () => {
  await goToSessions();

  // Click the alpha session to open detail panel
  await page.locator("text=E2E test session alpha").click();

  // Wait for detail panel to load with session ID
  await expect(page.locator("text=Details").first()).toBeVisible({ timeout: 5_000 });

  // Click Delete button in the detail panel
  await page.locator('button:has-text("Delete")').first().click();

  // Wait for status to update -- the detail panel should show "deleting" badge
  // and the Undelete button should appear
  await expect(page.locator('button:has-text("Undelete")')).toBeVisible({ timeout: 5_000 });

  // Undelete
  await page.locator('button:has-text("Undelete")').click();

  // Verify session is restored -- Delete button should reappear
  await expect(page.locator('button:has-text("Delete")')).toBeVisible({ timeout: 5_000 });

  // Close the detail panel
  await page.keyboard.press("Escape");
});

// -- Clone (fork) session -----------------------------------------------------

test("clone session via fork button", async () => {
  await goToSessions();

  // Click the alpha session to open detail panel
  await page.locator("text=E2E test session alpha").click();
  await expect(page.locator("text=Details").first()).toBeVisible({ timeout: 5_000 });

  // Click Fork button
  await page.locator('button:has-text("Fork")').first().click();

  // The fork action should succeed -- toast should appear
  // Reload and check that we have more sessions now
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Escape");

  // Verify via API that there are now at least 3 sessions
  const res = await fetch(`${ws.baseUrl}/api/sessions`);
  const sessions = await res.json();
  expect(sessions.length).toBeGreaterThanOrEqual(3);
});

// -- Archive and restore session ----------------------------------------------

test("archive and restore session", async () => {
  // Create a session and mark it completed so archive is available
  const createRes = await fetch(`${ws.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary: "E2E archive test", repo: ws.env.workdir, flow: "bare" }),
  });
  const createData = await createRes.json();
  const sessionId = createData.session?.id;
  expect(sessionId).toBeTruthy();

  // Complete the session via API so archive button shows
  await fetch(`${ws.baseUrl}/api/sessions/${sessionId}/complete`, { method: "POST" });

  // Reload and click into the completed session
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();
  await page.locator("text=E2E archive test").click();
  await expect(page.locator("text=Details").first()).toBeVisible({ timeout: 5_000 });

  // Archive
  await page.locator('button:has-text("Archive")').click();
  await expect(page.locator('button:has-text("Restore")')).toBeVisible({ timeout: 5_000 });

  // Restore
  await page.locator('button:has-text("Restore")').click();

  // After restore, Archive button should reappear (session goes back to completed)
  await expect(page.locator('button:has-text("Archive")')).toBeVisible({ timeout: 5_000 });

  // Close panel
  await page.keyboard.press("Escape");
});
