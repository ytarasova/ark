/**
 * End-to-end tests for session completion paths.
 *
 * Validates three completion mechanisms:
 * 1. Manual gate (bare flow) -- agent reports completed, session stays running,
 *    human must call advance() to complete.
 * 2. Auto gate (quick flow) -- agent reports completed, session auto-advances
 *    to next stage or completes.
 * 3. Hook fallback -- SessionEnd hook on auto-gate session transitions to completed.
 *
 * Also validates the conductor HTTP endpoint wiring for channel reports.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { startConductor } from "../conductor/conductor.js";
import { applyReport, applyHookStatus } from "../services/session-hooks.js";
import { advance } from "../services/stage-advance.js";
import type { OutboundMessage } from "../conductor/channel-types.js";

const TEST_PORT = 19197;

let app: AppContext;
let server: { stop(): void } | null = null;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
  }
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(() => {
  if (server) {
    try {
      server.stop();
    } catch {
      /* cleanup */
    }
    server = null;
  }
});

afterAll(async () => {
  if (server) {
    try {
      server.stop();
    } catch {
      /* cleanup */
    }
    server = null;
  }
  if (app) {
    await app.shutdown();
  }
});

// ── Manual completion path (bare flow, gate: manual) ────────────────────────

describe("Manual completion path (bare flow)", async () => {
  it("applyReport(completed) keeps manual-gate session running, does not advance", async () => {
    const session = await app.sessions.create({ summary: "manual test", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "work",
      summary: "All tasks done",
      filesChanged: ["src/main.ts"],
      commits: ["abc123"],
    };

    const result = await applyReport(app, session.id, report);

    // Manual gate: shouldAdvance must be false/undefined
    expect(result.shouldAdvance).toBeFalsy();
    // Status should NOT be set to "ready" -- session stays running
    expect(result.updates.status).toBeUndefined();
    // Completion data should still be saved
    expect(result.updates.config?.completion_summary).toBe("All tasks done");
    // Message should be generated for the UI
    expect(result.message).toBeTruthy();
    expect(result.message!.content).toContain("All tasks done");
    expect(result.message!.type).toBe("completed");
  });

  it("advance() fails on manual gate without force", async () => {
    const session = await app.sessions.create({ summary: "manual advance test", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    const advResult = await advance(app, session.id);
    expect(advResult.ok).toBe(false);
    expect(advResult.message).toContain("manual gate");
  });

  it("advance(force=true) completes the session past manual gate", async () => {
    const session = await app.sessions.create({ summary: "manual force test", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    const advResult = await advance(app, session.id, true);
    expect(advResult.ok).toBe(true);
    expect(advResult.message).toContain("completed");

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("full manual path: report -> human advance -> completed", async () => {
    const session = await app.sessions.create({ summary: "full manual path", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    // Step 1: Agent reports completed
    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "work",
      summary: "Implementation done",
      filesChanged: [],
      commits: [],
    };
    const result = await applyReport(app, session.id, report);

    // Apply updates (conductor would do this)
    if (Object.keys(result.updates).length > 0) {
      await app.sessions.update(session.id, result.updates);
    }
    if (result.message) {
      await app.messages.send(session.id, result.message.role, result.message.content, result.message.type);
    }

    // Session should still be running (manual gate)
    let current = await app.sessions.get(session.id);
    expect(current?.status).toBe("running");
    // Message should be stored
    const msgs = await app.messages.list(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("completed");

    // Step 2: Human forces advance
    const advResult = await advance(app, session.id, true);
    expect(advResult.ok).toBe(true);

    // Step 3: Session should be completed (bare flow has only one stage)
    current = await app.sessions.get(session.id);
    expect(current?.status).toBe("completed");
  });
});

// ── Auto completion path (quick flow, gate: auto) ───────────────────────────

describe("Auto completion path (quick flow)", async () => {
  it("applyReport(completed) sets shouldAdvance=true for auto-gate stage", async () => {
    const session = await app.sessions.create({ summary: "auto test", flow: "quick" });
    await app.sessions.update(session.id, { status: "running", stage: "implement" });

    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "Code written",
      filesChanged: ["src/feature.ts"],
      commits: ["def456"],
    };

    const result = await applyReport(app, session.id, report);

    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);
    expect(result.updates.status).toBe("ready");
  });

  it("advance() succeeds on auto-gate stage and moves to next stage", async () => {
    const session = await app.sessions.create({ summary: "auto advance test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    const advResult = await advance(app, session.id);
    expect(advResult.ok).toBe(true);

    const updated = await app.sessions.get(session.id);
    // quick flow: implement -> verify -> pr
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("advance() on last auto-gate stage completes the session", async () => {
    const session = await app.sessions.create({ summary: "auto last stage", flow: "quick" });
    // merge is the last stage in quick flow
    await app.sessions.update(session.id, { status: "ready", stage: "merge" });

    const advResult = await advance(app, session.id);
    expect(advResult.ok).toBe(true);
    expect(advResult.message).toContain("completed");

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("full auto path: report -> advance -> next stage ready", async () => {
    const session = await app.sessions.create({ summary: "full auto path", flow: "quick" });
    await app.sessions.update(session.id, { status: "running", stage: "implement" });

    // Step 1: Agent reports completed
    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "Feature implemented",
      filesChanged: ["src/feature.ts"],
      commits: ["ghi789"],
    };
    const result = await applyReport(app, session.id, report);

    // Apply updates (conductor would do this)
    await app.sessions.update(session.id, result.updates);

    // Step 2: Auto-advance (conductor would trigger this because shouldAdvance=true)
    expect(result.shouldAdvance).toBe(true);
    const advResult = await advance(app, session.id);
    expect(advResult.ok).toBe(true);

    // Step 3: Session should be at next stage
    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("full auto path through all stages to completion", async () => {
    const session = await app.sessions.create({ summary: "full auto completion", flow: "quick" });
    await app.sessions.update(session.id, { status: "running", stage: "implement" });

    // Simulate implement stage completion
    const r1 = await applyReport(app, session.id, {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "Implemented",
      filesChanged: [],
      commits: [],
    });
    await app.sessions.update(session.id, r1.updates);
    await advance(app, session.id);

    // Now at verify stage -- simulate verify completion
    await app.sessions.update(session.id, { status: "running" });
    const r2 = await applyReport(app, session.id, {
      type: "completed",
      sessionId: session.id,
      stage: "verify",
      summary: "Verified",
      filesChanged: [],
      commits: [],
    });
    await app.sessions.update(session.id, r2.updates);
    await advance(app, session.id);

    // Now at pr stage -- simulate pr completion
    await app.sessions.update(session.id, { status: "running" });
    const r3 = await applyReport(app, session.id, {
      type: "completed",
      sessionId: session.id,
      stage: "pr",
      summary: "PR created",
      filesChanged: [],
      commits: [],
    });
    await app.sessions.update(session.id, r3.updates);
    await advance(app, session.id);

    // Now at merge stage -- simulate merge completion
    await app.sessions.update(session.id, { status: "running" });
    const r4 = await applyReport(app, session.id, {
      type: "completed",
      sessionId: session.id,
      stage: "merge",
      summary: "Merged",
      filesChanged: [],
      commits: [],
    });
    await app.sessions.update(session.id, r4.updates);
    const finalAdv = await advance(app, session.id);

    // Session should now be completed (merge is last stage)
    expect(finalAdv.ok).toBe(true);
    expect(finalAdv.message).toContain("completed");
    const final = await app.sessions.get(session.id);
    expect(final?.status).toBe("completed");
  });
});

// ── Hook fallback path (SessionEnd on auto-gate) ────────────────────────────

describe("Hook fallback path (SessionEnd)", async () => {
  it("SessionEnd on auto-gate session sets status to ready with shouldAdvance", async () => {
    const session = await app.sessions.create({ summary: "hook fallback", flow: "quick" });
    await app.sessions.update(session.id, { status: "running", stage: "implement" });

    const freshSession = (await app.sessions.get(session.id))!;
    const result = await applyHookStatus(app, freshSession, "SessionEnd", {});

    expect(result.newStatus).toBe("ready");
    expect(result.updates?.status).toBe("ready");
    expect(result.shouldAdvance).toBe(true);
  });

  it("SessionEnd on manual-gate session keeps status running", async () => {
    const session = await app.sessions.create({ summary: "hook manual", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    const freshSession = (await app.sessions.get(session.id))!;
    const result = await applyHookStatus(app, freshSession, "SessionEnd", {});

    // Manual gate: SessionEnd maps to "running" (not "completed")
    expect(result.newStatus).toBe("running");
    expect(result.updates?.status).toBe("running");
  });

  it("StopFailure on auto-gate session sets status to failed", async () => {
    const session = await app.sessions.create({ summary: "hook failure", flow: "quick" });
    await app.sessions.update(session.id, { status: "running", stage: "implement" });

    const freshSession = (await app.sessions.get(session.id))!;
    const result = await applyHookStatus(app, freshSession, "StopFailure", {
      error: "agent crashed",
    });

    expect(result.newStatus).toBe("failed");
    expect(result.updates?.status).toBe("failed");
    expect(result.updates?.error).toBe("agent crashed");
  });

  it("StopFailure on manual-gate session keeps status running", async () => {
    const session = await app.sessions.create({ summary: "hook manual failure", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    const freshSession = (await app.sessions.get(session.id))!;
    const result = await applyHookStatus(app, freshSession, "StopFailure", {
      error: "auth failed",
    });

    // Manual gate: StopFailure maps to "running" (not "failed")
    expect(result.newStatus).toBe("running");
  });

  it("SessionEnd does not override already-completed status", async () => {
    const session = await app.sessions.create({ summary: "already done", flow: "quick" });
    await app.sessions.update(session.id, { status: "completed", stage: "implement" });

    const freshSession = (await app.sessions.get(session.id))!;
    const result = await applyHookStatus(app, freshSession, "SessionEnd", {});

    // Auto-gate SessionEnd maps to "ready", but guard blocks overriding "completed"
    expect(result.newStatus).toBeUndefined();
  });

  it("SessionEnd does not override stopped status", async () => {
    const session = await app.sessions.create({ summary: "stopped session", flow: "quick" });
    await app.sessions.update(session.id, { status: "stopped", stage: "implement" });

    const freshSession = (await app.sessions.get(session.id))!;
    const result = await applyHookStatus(app, freshSession, "SessionEnd", {});

    // Should be no-op -- session was manually stopped
    expect(result.newStatus).toBeUndefined();
  });

  it("hook events always generate audit log entries", async () => {
    const session = await app.sessions.create({ summary: "audit test", flow: "quick" });
    await app.sessions.update(session.id, { status: "running", stage: "implement" });

    const freshSession = (await app.sessions.get(session.id))!;
    const result = await applyHookStatus(app, freshSession, "SessionEnd", { reason: "task_complete" });

    expect(result.events).toBeTruthy();
    expect(result.events!.length).toBeGreaterThanOrEqual(1);
    const hookEvt = result.events!.find((e) => e.type === "hook_status");
    expect(hookEvt).toBeTruthy();
    expect(hookEvt!.opts.actor).toBe("hook");
    expect(hookEvt!.opts.data?.event).toBe("SessionEnd");
  });
});

// ── Conductor HTTP endpoint wiring ──────────────────────────────────────────

describe("Conductor channel report delivery", async () => {
  it("POST /api/channel/:id with completed report stores message and updates session", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = await app.sessions.create({ summary: "conductor test", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    const resp = await fetch(`http://localhost:${TEST_PORT}/api/channel/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "completed",
        sessionId: session.id,
        stage: "work",
        summary: "Task finished",
        filesChanged: ["src/app.ts"],
        commits: ["xyz789"],
      }),
    });

    expect(resp.status).toBe(200);

    // Message should be stored
    const msgs = await app.messages.list(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("agent");
    expect(msgs[0].type).toBe("completed");
    expect(msgs[0].content).toContain("Task finished");

    // Manual gate: session should stay running
    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("running");
  });

  it("POST /api/channel/:id with completed report on auto-gate advances session", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = await app.sessions.create({ summary: "auto conductor test", flow: "quick" });
    await app.sessions.update(session.id, { status: "running", stage: "implement" });

    const resp = await fetch(`http://localhost:${TEST_PORT}/api/channel/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "completed",
        sessionId: session.id,
        stage: "implement",
        summary: "Implemented the feature",
        filesChanged: ["src/feature.ts"],
        commits: ["commit1"],
      }),
    });

    expect(resp.status).toBe(200);

    // Auto gate: conductor should have advanced to next stage and auto-dispatched
    // Give a moment for the async advance to complete
    await new Promise((r) => setTimeout(r, 100));
    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    // Status is "running" because auto-dispatch is now properly awaited
    expect(updated?.status).toBe("running");
  });

  it("POST /hooks/status with SessionEnd on auto-gate advances session via HTTP", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = await app.sessions.create({ summary: "hook http test", flow: "quick" });
    await app.sessions.update(session.id, { status: "running", stage: "implement" });

    const resp = await fetch(`http://localhost:${TEST_PORT}/hooks/status?session=${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SessionEnd" }),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.mapped).toBe("ready");

    // Give a moment for the async advance to complete
    await new Promise((r) => setTimeout(r, 100));
    const updated = await app.sessions.get(session.id);
    // Auto-gate SessionEnd triggers advance to next stage and auto-dispatch
    expect(updated?.stage).toBe("verify");
    // Status is "running" because auto-dispatch is now properly awaited
    expect(updated?.status).toBe("running");
  });

  it("POST /hooks/status with SessionEnd on manual-gate keeps session running via HTTP", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = await app.sessions.create({ summary: "hook http manual", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    const resp = await fetch(`http://localhost:${TEST_PORT}/hooks/status?session=${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SessionEnd" }),
    });

    expect(resp.status).toBe(200);

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("running");
  });
});

// ── Regression: SessionService.complete() must advance, not leave "ready" ───

describe("Regression: complete() must advance flow (not leave status=ready)", async () => {
  it("SessionService.complete() + advance() on single-stage flow (bare) reaches 'completed'", async () => {
    // Use startSession (orchestration) to properly wire stage/flow like production
    const { startSession } = await import("../services/session-lifecycle.js");
    const session = await startSession(app, { summary: "svc complete bare", flow: "bare" });
    await app.sessions.update(session.id, { status: "running" });

    // Call complete via SessionService (same path as RPC handler)
    const result = await app.sessionService.complete(session.id);
    expect(result.ok).toBe(true);

    // Must call advance -- this is what the RPC handler must do
    const advResult = await app.sessionService.advance(session.id, true);
    expect(advResult.ok).toBe(true);

    // Session must be "completed", not stuck at "ready"
    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("SessionService.complete() + advance() on multi-stage flow (quick) advances to next stage", async () => {
    const { startSession } = await import("../services/session-lifecycle.js");
    const session = await startSession(app, { summary: "svc complete quick", flow: "quick" });
    // startSession sets stage to "implement" for quick flow
    await app.sessions.update(session.id, { status: "running" });

    const result = await app.sessionService.complete(session.id);
    expect(result.ok).toBe(true);

    const advResult = await app.sessionService.advance(session.id, true);
    expect(advResult.ok).toBe(true);

    // Should advance to next stage (verify), not stay at "ready" on "implement"
    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("RPC session/complete handler advances bare flow to 'completed'", async () => {
    const { startSession } = await import("../services/session-lifecycle.js");
    const session = await startSession(app, { summary: "rpc complete bare", flow: "bare" });
    await app.sessions.update(session.id, { status: "running" });

    // Use Router + registerSessionHandlers (same pattern as handler tests)
    const { Router } = await import("../../server/router.js");
    const { registerSessionHandlers } = await import("../../server/handlers/session.js");
    const { createRequest } = await import("../../protocol/types.js");

    const router = new Router();
    registerSessionHandlers(router, app);

    const res = await router.dispatch(createRequest(1, "session/complete", { sessionId: session.id }));

    // RPC should succeed
    expect((res as any).error).toBeUndefined();

    // The session must reach "completed" -- not stay at "ready"
    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("RPC session/complete handler advances quick flow to next stage", async () => {
    const { startSession } = await import("../services/session-lifecycle.js");
    const session = await startSession(app, { summary: "rpc complete quick", flow: "quick" });
    await app.sessions.update(session.id, { status: "running" });

    const { Router } = await import("../../server/router.js");
    const { registerSessionHandlers } = await import("../../server/handlers/session.js");
    const { createRequest } = await import("../../protocol/types.js");

    const router = new Router();
    registerSessionHandlers(router, app);

    const res = await router.dispatch(createRequest(1, "session/complete", { sessionId: session.id }));

    expect((res as any).error).toBeUndefined();

    // Should advance to "verify" stage, not stay at "ready" on "implement"
    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });
});
