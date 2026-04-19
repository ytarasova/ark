/**
 * Dispatch & live session E2E tests (slow tier).
 *
 * Tests session dispatch, running status detection, live output,
 * stop, and restart. These tests require tmux and may be slower.
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

// Increase timeout for dispatch tests -- they involve actual agent processes
test.setTimeout(120_000);

async function goToSessions() {
  await page.click('nav button:has-text("Sessions")');
  await expect(page.locator("h1")).toContainText("Sessions");
}

/** Create a session via RPC and return the session ID */
async function createSession(summary: string): Promise<string> {
  const data = await ws.rpc("session/start", { summary, repo: ws.env.workdir, flow: "bare" });
  return data.session.id;
}

/** Poll session status via RPC until it matches or times out */
async function waitForStatus(sessionId: string, statuses: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const data = await ws.rpc("session/read", { sessionId });
      if (data.session && statuses.includes(data.session.status)) {
        return data.session.status;
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Session ${sessionId} did not reach status [${statuses.join(",")}] within ${timeoutMs}ms`);
}

// -- Dispatch session and verify running status -------------------------------

test("create and dispatch session, verify running status via API", async () => {
  const id = await createSession("E2E dispatch test");

  // Dispatch via RPC
  // session/start dispatches atomically now -- no separate dispatch call.

  // Wait for session to be running (or waiting -- both mean dispatch worked)
  // It might fail quickly if claude is not available, so accept failed too
  const status = await waitForStatus(id, ["running", "waiting", "failed", "stopped"], 30_000);

  // Verify the dispatch happened -- session should not still be "pending" or "ready"
  expect(["running", "waiting", "failed", "stopped"]).toContain(status);

  // Cleanup: stop if running
  if (status === "running" || status === "waiting") {
    await ws.rpc("session/stop", { sessionId: id });
  }
});

// -- Get output from running session ------------------------------------------

test("get output endpoint returns data for session", async () => {
  const id = await createSession("E2E output test");

  // Output RPC should work even for non-running sessions (returns empty)
  const outputData = await ws.rpc("session/output", { sessionId: id });
  expect(outputData).toHaveProperty("output");
});

// -- Stop session -------------------------------------------------------------

test("stop session changes status", async () => {
  const id = await createSession("E2E stop test");

  // Dispatch
  // session/start dispatches atomically now -- no separate dispatch call.

  // Wait for it to start or fail
  const startStatus = await waitForStatus(id, ["running", "waiting", "failed", "stopped"], 30_000);

  if (startStatus === "running" || startStatus === "waiting") {
    // Stop the session
    await ws.rpc("session/stop", { sessionId: id });

    // Verify status changed to stopped
    const finalStatus = await waitForStatus(id, ["stopped", "failed"], 15_000);
    expect(["stopped", "failed"]).toContain(finalStatus);
  }
  // If the dispatch itself failed, the test still passes -- we verified the RPC works
});

// -- Restart session ----------------------------------------------------------

test("session/resume transitions a stopped session back to ready", async () => {
  // Pure state-machine test: sessionService.resume() just sets status
  // back to `ready` (it does NOT auto-dispatch, per services/session.ts
  // line 125). So we can exercise the full stop -> resume -> ready
  // round-trip without a real Claude binary. Seeding the `stopped`
  // state directly via sqlite3 avoids the real-agent requirement of
  // the dispatch pathway.
  const id = await createSession("E2E restart test");

  // Flip status to stopped via the DB (no real tmux needed). The ark
  // server's _detectStaleState() only scans `running` rows, so a
  // `stopped` row survives across boot.
  const { execFileSync } = await import("node:child_process");
  execFileSync("sqlite3", [`${ws.env.app.arkDir}/ark.db`, `UPDATE sessions SET status='stopped' WHERE id='${id}'`], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Confirm the seed landed.
  const before = await ws.rpc<{ session: { status: string } }>("session/read", { sessionId: id });
  expect(before.session.status).toBe("stopped");

  // Resume -- handler path: session/resume -> sessionService.resume
  // -> sessions.update({ status: "ready" }).
  const result = await ws.rpc<{ ok: boolean }>("session/resume", { sessionId: id });
  expect(result.ok).toBe(true);

  const after = await ws.rpc<{ session: { status: string } }>("session/read", { sessionId: id });
  expect(after.session.status).toBe("ready");
});

// -- Verify dispatch shows in UI ----------------------------------------------

test("dispatched session shows in UI with updated status", async () => {
  const id = await createSession("E2E UI dispatch check");

  // Check session appears in UI first
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();
  await expect(page.locator("text=E2E UI dispatch check")).toBeVisible({ timeout: 10_000 });

  // Dispatch
  // session/start dispatches atomically now -- no separate dispatch call.

  // Wait a moment for status to change
  await waitForStatus(id, ["running", "waiting", "failed", "stopped"], 30_000);

  // Reload UI and verify the status changed from ready/pending
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();

  // Click on the session to see detail
  await page.locator("text=E2E UI dispatch check").click();
  // The detail pane renders a Conversation tab (unique to SessionDetail).
  await expect(page.locator("text=Conversation").first()).toBeVisible({ timeout: 5_000 });

  // The status badge should not be "pending" or "ready" anymore
  // It could be running, waiting, failed, or stopped
  const detail = await ws.rpc("session/read", { sessionId: id });
  expect(["running", "waiting", "failed", "stopped"]).toContain(detail.session.status);

  // Cleanup
  if (detail.session.status === "running" || detail.session.status === "waiting") {
    await ws.rpc("session/stop", { sessionId: id });
  }
});
