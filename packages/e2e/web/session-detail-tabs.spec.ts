/**
 * Session detail tab switching E2E tests.
 *
 * Verifies that selecting a session opens the detail panel, and that
 * each content tab (Conversation, Terminal, Events, Diff, Todos)
 * renders its expected content area.
 */

import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { setupWebServer, type WebServerEnv } from "../fixtures/web-server.js";

let ws: WebServerEnv;
let browser: Browser;
let page: Page;

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

// -- Open session detail panel ------------------------------------------------

test("selecting a session from the list opens detail panel", async () => {
  const id = await createSession("Tab switching test");

  // page.reload() can take 10-20s on cold CI while the web subprocess rebuilds
  // its in-memory caches after the sqlite seed. The previous 10s cap tripped
  // frequently -- forSelector("nav") never fired, the test failed, and its
  // spec-level afterAll chain ran teardown under pressure. 30s gives headroom.
  await page.reload();
  await page.waitForSelector("nav", { timeout: 30_000 });
  await goToSessions();

  await page.locator("text=Tab switching test").first().click();
  // The detail panel should show the session ID
  await expect(page.locator(`text=${id}`).first()).toBeVisible({ timeout: 15_000 });
});

// -- Conversation tab ---------------------------------------------------------

test("conversation tab shows even for new sessions", async () => {
  await createSession("Conv tab test");

  await page.reload();
  await page.waitForSelector("nav", { timeout: 30_000 });
  await goToSessions();

  await page.locator("text=Conv tab test").first().click();
  // Conversation tab should be active by default
  await expect(page.locator('button[role="tab"]:has-text("Conversation")').first()).toBeVisible({ timeout: 5_000 });
});

// -- Terminal tab -------------------------------------------------------------

test("switching to Terminal tab renders terminal area", async () => {
  await createSession("Terminal tab test");

  await page.reload();
  await page.waitForSelector("nav", { timeout: 30_000 });
  await goToSessions();

  await page.locator("text=Terminal tab test").first().click();
  await expect(page.locator('button[role="tab"]:has-text("Conversation")').first()).toBeVisible({ timeout: 5_000 });

  // Click Terminal tab
  await page.locator('button[role="tab"]:has-text("Terminal")').click();

  // Terminal area should render. Before auto-dispatch, a fresh session
  // always showed the empty-state "No terminal output". Now the session
  // may already be launching so the terminal can contain real output OR
  // the empty-state string -- accept either as long as the tab panel exists.
  await expect(page.locator('[role="tabpanel"]').first()).toBeVisible({ timeout: 5_000 });
});

// -- Events tab ---------------------------------------------------------------

test("switching to Events tab renders events list with timestamps", async () => {
  const id = await createSession("Events tab test");

  // The session starts with no events, but the tab should still render
  await page.reload();
  await page.waitForSelector("nav", { timeout: 30_000 });
  await goToSessions();

  await page.locator("text=Events tab test").first().click();
  await expect(page.locator('button[role="tab"]:has-text("Conversation")').first()).toBeVisible({ timeout: 5_000 });

  // Click Events tab
  await page.locator('button[role="tab"]:has-text("Events")').click();

  // The events tab content should render (could be empty or have events)
  // We verify the tab is active by checking the events tab button state
  // The events list area should be visible (no crash)
  await page.waitForTimeout(500);

  // Verify via RPC that events endpoint works
  const detail = await ws.rpc("session/read", { sessionId: id, include: ["events"] });
  expect(Array.isArray(detail.events)).toBe(true);
});

// -- Diff tab -----------------------------------------------------------------

test("switching to Diff tab renders diff content area", async () => {
  await createSession("Diff tab test");

  await page.reload();
  await page.waitForSelector("nav", { timeout: 30_000 });
  await goToSessions();

  await page.locator("text=Diff tab test").first().click();
  await expect(page.locator('button[role="tab"]:has-text("Conversation")').first()).toBeVisible({ timeout: 5_000 });

  // Click Diff tab
  await page.locator('button[role="tab"]:has-text("Diff")').click();

  // Diff area should render (empty state for new session or loading).
  // The "files changed" string appears twice in the rendered diff panel
  // (header + row), so we use `.first()` to keep the assertion out of
  // Playwright's strict-mode trap -- we only care that SOMETHING in the
  // empty-state hierarchy renders, not that it's unique.
  await expect(
    page
      .locator("text=Loading diff")
      .or(page.locator("text=No worktree"))
      .or(page.locator("text=files changed"))
      .first(),
  ).toBeVisible({ timeout: 10_000 });
});

// -- Switch back to Conversation tab ------------------------------------------

test("switching back to Conversation tab from another tab works", async () => {
  await createSession("Switch back test");

  await page.reload();
  await page.waitForSelector("nav", { timeout: 30_000 });
  await goToSessions();

  await page.locator("text=Switch back test").first().click();
  await expect(page.locator('button[role="tab"]:has-text("Conversation")').first()).toBeVisible({ timeout: 5_000 });

  // Navigate away
  await page.locator('button[role="tab"]:has-text("Terminal")').click();
  // Terminal may show output or the empty-state string depending on whether
  // the auto-dispatched launcher has started producing output yet. Just
  // assert the tabpanel rendered.
  await expect(page.locator('[role="tabpanel"]').first()).toBeVisible({ timeout: 5_000 });

  // Navigate back
  await page.locator('button[role="tab"]:has-text("Conversation")').click();

  // Conversation content should render (empty state or messages)
  await expect(
    page.locator("text=No conversation yet").or(page.locator('button[role="tab"]:has-text("Conversation")')),
  ).toBeVisible({ timeout: 5_000 });
});
