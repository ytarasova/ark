/**
 * Flow progression E2E tests.
 *
 * Exercises the core Ark flow mechanic: session creation wires the first
 * stage of the selected flow, and `session/advance` moves the stage
 * pointer through the flow definition until the flow completes.
 *
 * These tests assert on ACTUAL stage name transitions discovered from
 * the shipped flow YAMLs:
 *   - `flows/definitions/bare.yaml`    -> 1 stage: work
 *   - `flows/definitions/default.yaml` -> 9 stages starting with intake
 *
 * All tests use `ws.rpc(...)` to talk to the backend directly rather
 * than the UI. A single test opens the web UI to verify the detail pane
 * renders the current stage name (the UI's flow-progression surface).
 *
 * No real agents are dispatched -- `session/advance` with force: true
 * just moves the stage pointer via `advance()` in session-orchestration,
 * which is exactly the mechanic we want to verify.
 */

import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { setupWebServer, type WebServerEnv } from "../fixtures/web-server.js";

let ws: WebServerEnv;
let browser: Browser;
let page: Page;

// Stage sequences copied from the builtin flow YAMLs. Tests assert on
// these literal strings -- if a YAML changes, these tests should break
// loudly so we know the flow contract moved.
const BARE_STAGES = ["work"] as const;
const DEFAULT_STAGES = ["intake", "plan", "audit", "implement", "verify", "pr", "review", "close", "retro"] as const;

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

// ─────────────────────────────────────────────────────────────────────────────
// 1. Bare flow: initial stage is "work"
// ─────────────────────────────────────────────────────────────────────────────

test("bare flow session starts on the `work` stage", async () => {
  const { session } = await ws.rpc<{ session: any }>("session/start", {
    repo: ws.env.workdir,
    summary: "bare-flow-initial-stage",
    flow: "bare",
  });
  expect(session).toBeTruthy();
  expect(session.flow).toBe("bare");
  expect(session.stage).toBe(BARE_STAGES[0]);
  expect(session.status).toBe("ready");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Default flow: initial stage is the first stage declared in default.yaml
// ─────────────────────────────────────────────────────────────────────────────

test("default flow session starts on the `intake` stage", async () => {
  const { session } = await ws.rpc<{ session: any }>("session/start", {
    repo: ws.env.workdir,
    summary: "default-flow-initial-stage",
    flow: "default",
  });
  expect(session).toBeTruthy();
  expect(session.flow).toBe("default");
  expect(session.stage).toBe(DEFAULT_STAGES[0]);
  expect(session.status).toBe("ready");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Advance through a multi-stage flow, verify each transition
// ─────────────────────────────────────────────────────────────────────────────

test("advancing a default-flow session walks every stage in order", async () => {
  const { session } = await ws.rpc<{ session: any }>("session/start", {
    repo: ws.env.workdir,
    summary: "default-flow-walk",
    flow: "default",
  });
  const id: string = session.id;
  expect(session.stage).toBe(DEFAULT_STAGES[0]);

  // Advance step by step and assert the session's stage field matches
  // the next name in the linear YAML order. Use `force: true` so manual
  // gates (plan, review) don't block progression. The advance() fn in
  // session-orchestration linearly walks `stages[]` when no graph-flow
  // edges are declared -- default.yaml is pure linear, so we expect
  // DEFAULT_STAGES[i] -> DEFAULT_STAGES[i+1] for each advance call.
  for (let i = 1; i < DEFAULT_STAGES.length; i++) {
    const advanceRes = await ws.rpc<{ ok: boolean; message: string }>("session/advance", {
      sessionId: id,
      force: true,
    });
    expect(advanceRes.ok).toBe(true);

    const { session: afterAdvance } = await ws.rpc<{ session: any }>("session/read", { sessionId: id });
    expect(afterAdvance.stage).toBe(DEFAULT_STAGES[i]);
    // While stages remain, status should reset to `ready` (not completed).
    expect(afterAdvance.status).toBe("ready");
  }

  // One more advance past the final stage completes the flow.
  const finalAdvance = await ws.rpc<{ ok: boolean; message: string }>("session/advance", {
    sessionId: id,
    force: true,
  });
  expect(finalAdvance.ok).toBe(true);

  // session/start now auto-dispatches. If the first-stage launcher is still
  // spinning up when we force-advance through the whole flow, its delayed
  // status write can race with "completed". Poll for the expected terminal
  // status (guarded by the dispatch stage-changed check in the server) so
  // the assertion is deterministic.
  let done: any = null;
  for (let i = 0; i < 20; i++) {
    const read = await ws.rpc<{ session: any }>("session/read", { sessionId: id });
    done = read.session;
    if (done.status === "completed") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  expect(done.status).toBe("completed");
  // Stage field still reflects the final stage that completed.
  expect(done.stage).toBe(DEFAULT_STAGES[DEFAULT_STAGES.length - 1]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Bare flow advance: single stage -> flow completes
// ─────────────────────────────────────────────────────────────────────────────

test("advancing a bare-flow session past its single stage completes the flow", async () => {
  const { session } = await ws.rpc<{ session: any }>("session/start", {
    repo: ws.env.workdir,
    summary: "bare-flow-completion",
    flow: "bare",
  });
  const id: string = session.id;
  expect(session.stage).toBe("work");
  expect(session.status).toBe("ready");

  // `bare` has a manual gate so we must force.
  const advanceRes = await ws.rpc<{ ok: boolean; message: string }>("session/advance", { sessionId: id, force: true });
  expect(advanceRes.ok).toBe(true);

  const { session: done } = await ws.rpc<{ session: any }>("session/read", {
    sessionId: id,
  });
  expect(done.status).toBe("completed");
  // After flow completion the session still reports the last stage.
  expect(done.stage).toBe("work");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Web UI shows the current stage in the session detail pane
// ─────────────────────────────────────────────────────────────────────────────

test("session detail pane renders the current flow stage", async () => {
  const summary = "flow-ui-detail-stage";
  const { session } = await ws.rpc<{ session: any }>("session/start", {
    repo: ws.env.workdir,
    summary,
    flow: "default",
  });
  expect(session.stage).toBe(DEFAULT_STAGES[0]);

  // Advance one step so the displayed stage is distinctly not the
  // initial stage -- this proves the UI is reading live state, not
  // hydrating from the creation snapshot.
  await ws.rpc("session/advance", { sessionId: session.id, force: true });
  const { session: afterAdvance } = await ws.rpc<{ session: any }>("session/read", { sessionId: session.id });
  expect(afterAdvance.stage).toBe(DEFAULT_STAGES[1]); // plan

  // Reload so the UI fetches the latest session list + detail.
  await page.reload();
  await page.waitForSelector("nav", { timeout: 15_000 });
  await page.click('nav button:has-text("Sessions")');
  await expect(page.locator("h1")).toContainText("Sessions");

  // Open the session detail pane.
  await page.locator(`text=${summary}`).first().click();
  // The detail pane renders a Conversation tab (unique to SessionDetail).
  await expect(page.locator("text=Conversation").first()).toBeVisible({
    timeout: 5_000,
  });

  // The SessionHeader renders a StagePipeline whose stage-name buttons
  // include the current stage. `plan` should appear in the pipeline
  // breadcrumb once the session has advanced one step.
  await expect(page.locator("text=plan").first()).toBeVisible({
    timeout: 5_000,
  });

  // Flow name is rendered in the sub-header row next to the agent name.
  await expect(page.locator("text=default").first()).toBeVisible({
    timeout: 5_000,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Flow name is preserved across reload
// ─────────────────────────────────────────────────────────────────────────────

test("session flow field survives a web UI reload", async () => {
  const summary = "flow-ui-persist-reload";
  const { session } = await ws.rpc<{ session: any }>("session/start", {
    repo: ws.env.workdir,
    summary,
    flow: "default",
  });
  expect(session.flow).toBe("default");

  await page.reload();
  await page.waitForSelector("nav", { timeout: 15_000 });
  await page.click('nav button:has-text("Sessions")');
  await expect(page.locator("h1")).toContainText("Sessions");

  await page.locator(`text=${summary}`).first().click();
  // The detail pane renders a Conversation tab (unique to SessionDetail).
  await expect(page.locator("text=Conversation").first()).toBeVisible({
    timeout: 5_000,
  });

  // The flow name renders in the detail sub-header and the stage name in
  // the StagePipeline breadcrumb. We verify via RPC (authoritative) and
  // via the rendered page (surface the user sees).
  const { session: refetched } = await ws.rpc<{ session: any }>("session/read", { sessionId: session.id });
  expect(refetched.flow).toBe("default");
  expect(refetched.stage).toBe(DEFAULT_STAGES[0]);

  // Stage label should still show the first stage name in the UI.
  await expect(page.locator(`text=${DEFAULT_STAGES[0]}`).first()).toBeVisible({
    timeout: 5_000,
  });
});
