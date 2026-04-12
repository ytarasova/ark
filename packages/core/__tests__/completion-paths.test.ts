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
import { AppContext, getApp, setApp, clearApp } from "../app.js";
import { startConductor } from "../conductor/conductor.js";
import { applyReport, applyHookStatus, advance } from "../services/session-orchestration.js";
import type { OutboundMessage } from "../conductor/channel-types.js";

const TEST_PORT = 19197;

let app: AppContext;
let server: { stop(): void } | null = null;

beforeEach(async () => {
  if (app) { await app.shutdown(); clearApp(); }
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterEach(() => {
  if (server) { try { server.stop(); } catch { /* cleanup */ } server = null; }
});

afterAll(async () => {
  if (server) { try { server.stop(); } catch { /* cleanup */ } server = null; }
  if (app) { await app.shutdown(); clearApp(); }
});

// ── Manual completion path (bare flow, gate: manual) ────────────────────────

describe("Manual completion path (bare flow)", () => {
  it("applyReport(completed) keeps manual-gate session running, does not advance", () => {
    const session = app.sessions.create({ summary: "manual test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "work",
      summary: "All tasks done",
      filesChanged: ["src/main.ts"],
      commits: ["abc123"],
    };

    const result = applyReport(app, session.id, report);

    // Manual gate: shouldAdvance must be false/undefined
    expect(result.shouldAdvance).toBeFalsy();
    // Status should NOT be set to "ready" -- session stays running
    expect(result.updates.status).toBeUndefined();
    // Completion data should still be saved
    expect(result.updates.config?.completion_summary).toBe("All tasks done");
    // Message should be generated for TUI
    expect(result.message).toBeTruthy();
    expect(result.message!.content).toContain("All tasks done");
    expect(result.message!.type).toBe("completed");
  });

  it("advance() fails on manual gate without force", async () => {
    const session = app.sessions.create({ summary: "manual advance test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const advResult = await advance(app, session.id);
    expect(advResult.ok).toBe(false);
    expect(advResult.message).toContain("manual gate");
  });

  it("advance(force=true) completes the session past manual gate", async () => {
    const session = app.sessions.create({ summary: "manual force test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const advResult = await advance(app, session.id, true);
    expect(advResult.ok).toBe(true);
    expect(advResult.message).toContain("completed");

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("full manual path: report -> human advance -> completed", async () => {
    const session = app.sessions.create({ summary: "full manual path", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    // Step 1: Agent reports completed
    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "work",
      summary: "Implementation done",
      filesChanged: [],
      commits: [],
    };
    const result = applyReport(app, session.id, report);

    // Apply updates (conductor would do this)
    if (Object.keys(result.updates).length > 0) {
      app.sessions.update(session.id, result.updates);
    }
    if (result.message) {
      app.messages.send(session.id, result.message.role, result.message.content, result.message.type);
    }

    // Session should still be running (manual gate)
    let current = app.sessions.get(session.id);
    expect(current?.status).toBe("running");
    // Message should be stored
    const msgs = app.messages.list(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("completed");

    // Step 2: Human forces advance
    const advResult = await advance(app, session.id, true);
    expect(advResult.ok).toBe(true);

    // Step 3: Session should be completed (bare flow has only one stage)
    current = app.sessions.get(session.id);
    expect(current?.status).toBe("completed");
  });
});

// ── Auto completion path (quick flow, gate: auto) ───────────────────────────

describe("Auto completion path (quick flow)", () => {
  it("applyReport(completed) sets shouldAdvance=true for auto-gate stage", () => {
    const session = app.sessions.create({ summary: "auto test", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "Code written",
      filesChanged: ["src/feature.ts"],
      commits: ["def456"],
    };

    const result = applyReport(app, session.id, report);

    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);
    expect(result.updates.status).toBe("ready");
  });

  it("advance() succeeds on auto-gate stage and moves to next stage", async () => {
    const session = app.sessions.create({ summary: "auto advance test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement" });

    const advResult = await advance(app, session.id);
    expect(advResult.ok).toBe(true);

    const updated = app.sessions.get(session.id);
    // quick flow: implement -> verify -> pr
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("advance() on last auto-gate stage completes the session", async () => {
    const session = app.sessions.create({ summary: "auto last stage", flow: "quick" });
    // pr is the last stage in quick flow
    app.sessions.update(session.id, { status: "ready", stage: "pr" });

    const advResult = await advance(app, session.id);
    expect(advResult.ok).toBe(true);
    expect(advResult.message).toContain("completed");

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("full auto path: report -> advance -> next stage ready", async () => {
    const session = app.sessions.create({ summary: "full auto path", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    // Step 1: Agent reports completed
    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "Feature implemented",
      filesChanged: ["src/feature.ts"],
      commits: ["ghi789"],
    };
    const result = applyReport(app, session.id, report);

    // Apply updates (conductor would do this)
    app.sessions.update(session.id, result.updates);

    // Step 2: Auto-advance (conductor would trigger this because shouldAdvance=true)
    expect(result.shouldAdvance).toBe(true);
    const advResult = await advance(app, session.id);
    expect(advResult.ok).toBe(true);

    // Step 3: Session should be at next stage
    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("full auto path through all stages to completion", async () => {
    const session = app.sessions.create({ summary: "full auto completion", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    // Simulate implement stage completion
    const r1 = applyReport(app, session.id, {
      type: "completed", sessionId: session.id, stage: "implement",
      summary: "Implemented", filesChanged: [], commits: [],
    });
    app.sessions.update(session.id, r1.updates);
    await advance(app, session.id);

    // Now at verify stage -- simulate verify completion
    app.sessions.update(session.id, { status: "running" });
    const r2 = applyReport(app, session.id, {
      type: "completed", sessionId: session.id, stage: "verify",
      summary: "Verified", filesChanged: [], commits: [],
    });
    app.sessions.update(session.id, r2.updates);
    await advance(app, session.id);

    // Now at pr stage -- simulate pr completion
    app.sessions.update(session.id, { status: "running" });
    const r3 = applyReport(app, session.id, {
      type: "completed", sessionId: session.id, stage: "pr",
      summary: "PR created", filesChanged: [], commits: [],
    });
    app.sessions.update(session.id, r3.updates);
    const finalAdv = await advance(app, session.id);

    // Session should now be completed (pr is last stage)
    expect(finalAdv.ok).toBe(true);
    expect(finalAdv.message).toContain("completed");
    const final = app.sessions.get(session.id);
    expect(final?.status).toBe("completed");
  });
});

// ── Hook fallback path (SessionEnd on auto-gate) ────────────────────────────

describe("Hook fallback path (SessionEnd)", () => {
  it("SessionEnd on auto-gate session sets status to completed", () => {
    const session = app.sessions.create({ summary: "hook fallback", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    const freshSession = app.sessions.get(session.id)!;
    const result = applyHookStatus(app, freshSession, "SessionEnd", {});

    expect(result.newStatus).toBe("completed");
    expect(result.updates?.status).toBe("completed");
  });

  it("SessionEnd on manual-gate session keeps status running", () => {
    const session = app.sessions.create({ summary: "hook manual", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const freshSession = app.sessions.get(session.id)!;
    const result = applyHookStatus(app, freshSession, "SessionEnd", {});

    // Manual gate: SessionEnd maps to "running" (not "completed")
    expect(result.newStatus).toBe("running");
    expect(result.updates?.status).toBe("running");
  });

  it("StopFailure on auto-gate session sets status to failed", () => {
    const session = app.sessions.create({ summary: "hook failure", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    const freshSession = app.sessions.get(session.id)!;
    const result = applyHookStatus(app, freshSession, "StopFailure", {
      error: "agent crashed",
    });

    expect(result.newStatus).toBe("failed");
    expect(result.updates?.status).toBe("failed");
    expect(result.updates?.error).toBe("agent crashed");
  });

  it("StopFailure on manual-gate session keeps status running", () => {
    const session = app.sessions.create({ summary: "hook manual failure", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const freshSession = app.sessions.get(session.id)!;
    const result = applyHookStatus(app, freshSession, "StopFailure", {
      error: "auth failed",
    });

    // Manual gate: StopFailure maps to "running" (not "failed")
    expect(result.newStatus).toBe("running");
  });

  it("SessionEnd does not override already-completed status", () => {
    const session = app.sessions.create({ summary: "already done", flow: "quick" });
    app.sessions.update(session.id, { status: "completed", stage: "implement" });

    const freshSession = app.sessions.get(session.id)!;
    const result = applyHookStatus(app, freshSession, "SessionEnd", {});

    // SessionEnd maps to "completed" which matches current status -- no real change
    expect(result.newStatus).toBe("completed");
  });

  it("SessionEnd does not override stopped status", () => {
    const session = app.sessions.create({ summary: "stopped session", flow: "quick" });
    app.sessions.update(session.id, { status: "stopped", stage: "implement" });

    const freshSession = app.sessions.get(session.id)!;
    const result = applyHookStatus(app, freshSession, "SessionEnd", {});

    // Should be no-op -- session was manually stopped
    expect(result.newStatus).toBeUndefined();
  });

  it("hook events always generate audit log entries", () => {
    const session = app.sessions.create({ summary: "audit test", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    const freshSession = app.sessions.get(session.id)!;
    const result = applyHookStatus(app, freshSession, "SessionEnd", { reason: "task_complete" });

    expect(result.events).toBeTruthy();
    expect(result.events!.length).toBeGreaterThanOrEqual(1);
    const hookEvt = result.events!.find(e => e.type === "hook_status");
    expect(hookEvt).toBeTruthy();
    expect(hookEvt!.opts.actor).toBe("hook");
    expect(hookEvt!.opts.data?.event).toBe("SessionEnd");
  });
});

// ── Conductor HTTP endpoint wiring ──────────────────────────────────────────

describe("Conductor channel report delivery", () => {
  it("POST /api/channel/:id with completed report stores message and updates session", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = app.sessions.create({ summary: "conductor test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

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
    const msgs = app.messages.list(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("agent");
    expect(msgs[0].type).toBe("completed");
    expect(msgs[0].content).toContain("Task finished");

    // Manual gate: session should stay running
    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("running");
  });

  it("POST /api/channel/:id with completed report on auto-gate advances session", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = app.sessions.create({ summary: "auto conductor test", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

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

    // Auto gate: conductor should have advanced to next stage
    // Give a moment for the async advance to complete
    await new Promise(r => setTimeout(r, 100));
    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("POST /hooks/status with SessionEnd on auto-gate completes session via HTTP", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = app.sessions.create({ summary: "hook http test", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    const resp = await fetch(
      `http://localhost:${TEST_PORT}/hooks/status?session=${session.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: "SessionEnd" }),
      },
    );

    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.mapped).toBe("completed");

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("POST /hooks/status with SessionEnd on manual-gate keeps session running via HTTP", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = app.sessions.create({ summary: "hook http manual", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const resp = await fetch(
      `http://localhost:${TEST_PORT}/hooks/status?session=${session.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: "SessionEnd" }),
      },
    );

    expect(resp.status).toBe(200);

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("running");
  });
});
