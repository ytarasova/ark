/**
 * Session CRUD E2E tests.
 *
 * Tests session creation via inline form, filtering by status chips,
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
  // Search is collapsed behind an icon toggle -- click to expand the input.
  await page.locator('button[title="Search (/ )"]').click();
  await expect(page.locator('input[placeholder*="Search"]')).toBeVisible();
});

// TODO(#176): SessionList only renders chips for running/waiting/completed/
// failed statuses (see packages/web/src/components/SessionList.tsx). Fresh
// sessions created via `session/start` in the e2e fixture land in "ready"
// status and never transition to one of those four without a live conductor
// to dispatch them. Re-enable when the fixture can produce a running session.
test.skip("sessions page shows filter chips", async () => {
  await goToSessions();
});

test("sessions page shows New Session button", async () => {
  await expect(page.locator('button:has-text("New Session")')).toBeVisible();
});

// -- Create session via inline form -------------------------------------------

test("create session via New Session inline form", async () => {
  await goToSessions();

  // Open the inline form in the right panel
  await page.click('button:has-text("New Session")');
  await expect(page.locator("text=New Session").first()).toBeVisible();

  // Fill in the summary field
  const summaryInput = page.locator('textarea[placeholder="What should the agent work on?"]');
  await expect(summaryInput).toBeVisible();
  await summaryInput.fill("E2E test session alpha");

  // Fill in the repo field via the popover picker.
  await page.locator('button:has-text("Select repository")').click();
  const repoInput = page.locator('input[placeholder="Type path or search..."]');
  await expect(repoInput).toBeVisible({ timeout: 5_000 });
  await repoInput.fill(ws.env.workdir);
  await repoInput.press("Enter");

  // Submit the form
  await page.click('button:has-text("Start Session")');

  // Wait for session to appear in the list. Use .first() because once the
  // session is selected the detail pane (and its event feed) also contain
  // the summary -- strict mode would otherwise flag multiple matches.
  await expect(page.locator("text=E2E test session alpha").first()).toBeVisible({ timeout: 10_000 });
});

// -- Create a second session for filtering tests ------------------------------

test("create second session for filtering", async () => {
  // Create via RPC for speed
  const data = await ws.rpc("session/start", { summary: "E2E test session beta", repo: ws.env.workdir, flow: "bare" });
  expect(data.session).toBeTruthy();

  // Refresh the page to see both sessions
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();
  await expect(page.locator("text=E2E test session beta").first()).toBeVisible({ timeout: 10_000 });
});

// -- Search sessions ----------------------------------------------------------

test("search filters sessions by summary text", async () => {
  await goToSessions();
  // Dismiss any lingering selection so the detail pane + its event feed
  // don't leak extra matches of the session summary into the page (auto-
  // dispatch writes a `session_created` event that the conversation
  // timeline echoes, which violates Playwright's strict-mode locator).
  await page.keyboard.press("Escape");

  // Search is collapsed behind an icon toggle -- click to open the input.
  await page.locator('button[title="Search (/ )"]').click();
  const searchInput = page.locator('input[placeholder*="Search"]');
  await expect(searchInput).toBeVisible({ timeout: 5_000 });
  await searchInput.fill("alpha");

  // Alpha session should be visible. Use .first() because even with the
  // detail pane closed the SessionCard + nav breadcrumb both contain the
  // summary; we only care that filtering shows *at least one* alpha row.
  await expect(page.locator("text=E2E test session alpha").first()).toBeVisible();
  // Beta session should be hidden
  await expect(page.locator("text=E2E test session beta")).not.toBeVisible();

  // Clear search
  await searchInput.fill("");
  await expect(page.locator("text=E2E test session beta").first()).toBeVisible();
});

// -- Filter by status chips ---------------------------------------------------

// TODO(#177): The FilterChip UI was rewritten: only chips for statuses
// with sessions are rendered, there is no "All" chip (deselect by clicking
// the active chip again), and labels are lowercase ("3 running", not
// "Running"). This test's assertions no longer map to the UI and need
// rewriting against the current contract.
test.skip("filter chips show only matching status sessions", async () => {
  await goToSessions();
  await page.click('button:has-text("Running")');
  await expect(page.locator("text=E2E test session alpha")).not.toBeVisible({ timeout: 3_000 });
  await page.click('button:has-text("All")');
  await expect(page.locator("text=E2E test session alpha")).toBeVisible();
});

// -- Delete and undelete session ----------------------------------------------

test("delete and undelete session via RPC", async () => {
  // The SessionDetail header no longer exposes inline Delete/Undelete
  // buttons -- deletion now goes through a confirm dialog from the
  // session row context menu, and undo is a toast. Drive the lifecycle
  // through RPCs so we exercise the real handler; the UI layer is
  // covered by sessions-page / detail-drawer unit tests.
  const list = await ws.rpc<{ sessions: Array<{ id: string; summary: string }> }>("session/list", { limit: 200 });
  const alpha = list.sessions.find((s) => s.summary === "E2E test session alpha");
  expect(alpha).toBeTruthy();

  const deleteRes = await ws.rpc<{ ok: boolean }>("session/delete", { sessionId: alpha!.id });
  expect(deleteRes.ok).not.toBe(false);

  const undeleteRes = await ws.rpc<{ ok: boolean }>("session/undelete", { sessionId: alpha!.id });
  expect(undeleteRes.ok).not.toBe(false);

  // After undelete, the session should be listable again.
  const after = await ws.rpc<{ sessions: Array<{ id: string; summary: string }> }>("session/list", { limit: 200 });
  expect(after.sessions.some((s) => s.id === alpha!.id)).toBe(true);
});

// -- Clone (fork) session -----------------------------------------------------

test("clone session via fork RPC", async () => {
  // The SessionDetail header no longer surfaces a visible "Fork" button --
  // the action moved behind a context menu. Drive the RPC directly so the
  // handler stays covered; UI wiring is covered by detail-drawer tests.
  const list = await ws.rpc<{ sessions: Array<{ id: string; summary: string }> }>("session/list", { limit: 200 });
  const alpha = list.sessions.find((s) => s.summary === "E2E test session alpha");
  expect(alpha).toBeTruthy();

  const before = list.sessions.length;
  await ws.rpc("session/fork", { sessionId: alpha!.id });

  const after = await ws.rpc<{ sessions: Array<{ id: string; summary: string }> }>("session/list", { limit: 200 });
  expect(after.sessions.length).toBeGreaterThan(before);
});

// -- Archive and restore session ----------------------------------------------

test("session/archive and session/restore transition status via RPC", async () => {
  // Rewrite: drive the full complete -> archive -> restore chain
  // through RPCs rather than UI clicks. The old UI flow was flaky
  // under suite pressure (browser context would close mid-click on
  // the Archive button). The RPC layer is the real integration
  // boundary we care about -- the UI is just a button wiring it up.
  const createData = await ws.rpc<{ session: { id: string } }>("session/start", {
    summary: "E2E archive test",
    repo: ws.env.workdir,
    flow: "bare",
  });
  const sessionId = createData.session.id;

  // Complete -> archive requires status in {completed, stopped, failed}.
  await ws.rpc("session/complete", { sessionId });
  const completed = await ws.rpc<{ session: { status: string } }>("session/read", { sessionId });
  expect(["completed", "ready"]).toContain(completed.session.status);

  // Archive.
  const archived = await ws.rpc<{ ok: boolean }>("session/archive", { sessionId });
  expect(archived.ok).toBe(true);
  const afterArchive = await ws.rpc<{ session: { status: string } }>("session/read", { sessionId });
  expect(afterArchive.session.status).toBe("archived");

  // Restore.
  const restored = await ws.rpc<{ ok: boolean }>("session/restore", { sessionId });
  expect(restored.ok).toBe(true);
  const afterRestore = await ws.rpc<{ session: { status: string } }>("session/read", { sessionId });
  // Restore flips back to whatever the pre-archive status was (or
  // `ready`/`completed`). The assertion is that it is NOT still
  // archived.
  expect(afterRestore.session.status).not.toBe("archived");
});
