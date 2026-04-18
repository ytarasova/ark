/**
 * Tests for the autonomous flow and auto-gate completion logic.
 *
 * Validates:
 * 1. applyReport with type=completed on gate:auto sets shouldAdvance
 * 2. applyHookStatus with SessionEnd on running gate:auto triggers implicit completion
 * 3. The autonomous flow definition loads correctly
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getApp } from "../app.js";
import { applyReport, applyHookStatus } from "../services/session-orchestration.js";
import { startConductor } from "../conductor/conductor.js";
import { withTestContext } from "./test-helpers.js";
import { allocatePort } from "./helpers/test-env.js";

const { getCtx } = withTestContext();

// ── Unit tests for applyReport / applyHookStatus ────────────────────────────

describe("applyReport auto-gate completion", () => {
  it("sets shouldAdvance for gate:auto stage", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "auto test", flow: "autonomous" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const result = applyReport(app, session.id, {
      type: "completed",
      stage: "work",
      summary: "Done",
    } as any);

    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);
    expect(result.updates.status).toBe("ready");
  });

  it("clears stale error on completed report so auto-gate passes", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "stale error test", flow: "autonomous" });
    // Simulate: agent failed once, error was set, then retry succeeded
    app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      error: "previous failure from first attempt",
    });

    const result = applyReport(app, session.id, {
      type: "completed",
      stage: "work",
      summary: "Done on retry",
    } as any);

    expect(result.shouldAdvance).toBe(true);
    expect(result.updates.status).toBe("ready");
    // The error field must be explicitly cleared so evaluateGate("auto") passes
    expect(result.updates.error).toBeNull();
  });

  it("does NOT set shouldAdvance for gate:manual stage", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "manual test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const result = applyReport(app, session.id, {
      type: "completed",
      stage: "work",
      summary: "Done",
    } as any);

    expect(result.shouldAdvance).toBeFalsy();
    expect(result.shouldAutoDispatch).toBeFalsy();
    // Manual gate: status stays unchanged (no status update)
    expect(result.updates.status).toBeUndefined();
  });
});

describe("applyHookStatus SessionEnd auto-gate fallback", () => {
  it("sets shouldAdvance on SessionEnd for auto-gate running session", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "auto test", flow: "autonomous" });
    app.sessions.update(session.id, { status: "running", stage: "work" });
    const fresh = app.sessions.get(session.id)!;

    const result = applyHookStatus(app, fresh, "SessionEnd", {});

    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);
    expect(result.newStatus).toBe("ready");
  });

  it("does NOT set shouldAdvance on SessionEnd for manual-gate session", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "manual test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });
    const fresh = app.sessions.get(session.id)!;

    const result = applyHookStatus(app, fresh, "SessionEnd", {});

    expect(result.shouldAdvance).toBeFalsy();
    // Manual gate: session stays running
    expect(result.newStatus).toBe("running");
  });

  it("does NOT set shouldAdvance when session is not running", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "auto test", flow: "autonomous" });
    // Session already completed -- late hook should not trigger advance
    app.sessions.update(session.id, { status: "completed", stage: "work" });
    const fresh = app.sessions.get(session.id)!;

    const result = applyHookStatus(app, fresh, "SessionEnd", {});

    expect(result.shouldAdvance).toBeFalsy();
  });
});

// ── Integration test via conductor HTTP ─────────────────────────────────────

let TEST_PORT: number;

describe("autonomous flow via conductor", () => {
  let server: { stop(): void };

  beforeEach(async () => {
    TEST_PORT = await allocatePort();
    server = startConductor(getApp(), TEST_PORT, { quiet: true });
  });

  afterEach(() => {
    try {
      server.stop();
    } catch {
      /* cleanup */
    }
  });

  async function postHook(sessionId: string, payload: Record<string, unknown>): Promise<Response> {
    return fetch(`http://localhost:${TEST_PORT}/hooks/status?session=${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  it("SessionEnd on single-stage autonomous flow completes the session", async () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "auto complete test", flow: "autonomous" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const resp = await postHook(session.id, { hook_event_name: "SessionEnd" });
    expect(resp.status).toBe(200);

    const updated = app.sessions.get(session.id);
    // advance() on single-stage flow completes the session
    expect(updated?.status).toBe("completed");
  });

  it("SessionEnd on manual-gate bare flow keeps session running", async () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "bare test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const resp = await postHook(session.id, { hook_event_name: "SessionEnd" });
    expect(resp.status).toBe(200);

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("running");
  });
});

// ── Flow definition loading ─────────────────────────────────────────────────

describe("autonomous flow definition", () => {
  it("loads the autonomous flow with auto gate", () => {
    const flow = getApp().flows.get("autonomous");
    expect(flow).not.toBeNull();
    expect(flow!.name).toBe("autonomous");
    expect(flow!.stages).toHaveLength(1);
    expect(flow!.stages[0].name).toBe("work");
    expect(flow!.stages[0].gate).toBe("auto");
  });
});
