/**
 * Tests for orchestrator-mediated stage handoff.
 *
 * Validates the mediateStageHandoff() function which consolidates the
 * verify -> advance -> dispatch chain into a single orchestration entry point.
 *
 * Test coverage:
 * 1. Auto-gate handoff advances to next stage and dispatches
 * 2. Manual-gate handoff is blocked by gate evaluation
 * 3. Verification failure blocks handoff
 * 4. Flow completion on last stage
 * 5. Action stage auto-execution after handoff
 * 6. Handoff events are emitted for observability
 * 7. Integration with conductor report/hook paths
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../app.js";
import { startConductor } from "../conductor/conductor.js";
import type { OutboundMessage } from "../conductor/channel-types.js";

let app: AppContext;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
  }
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  // no-op -- beforeEach handles cleanup
});

// ── Unit tests for mediateStageHandoff ────────────────────────────────────

describe("mediateStageHandoff", async () => {
  describe("auto-gate handoff", async () => {
    it("advances from current stage to next stage", async () => {
      const session = await app.sessions.create({ summary: "handoff test", flow: "quick" });
      await app.sessions.update(session.id, { status: "ready", stage: "implement" });

      // Stub dispatch to succeed without touching the real launch path so the
      // test exercises mediator logic in isolation. The flip-to-running side
      // effect is the dispatcher's responsibility -- we mimic it here.
      app.container.register({
        dispatchService: asValue({
          dispatch: async (id: string) => {
            await app.sessions.update(id, { session_id: `ark-s-${id}`, status: "running" });
            return { ok: true, message: "stubbed-dispatch" };
          },
        }),
      });

      const result = await app.sessionHooks.mediateStageHandoff(session.id, { source: "test" });

      expect(result.ok).toBe(true);
      expect(result.fromStage).toBe("implement");
      expect(result.toStage).toBe("verify");

      const updated = await app.sessions.get(session.id);
      expect(updated?.stage).toBe("verify");
      expect(updated?.status).toBe("running");
    });

    it("returns dispatched=true when autoDispatch is enabled", async () => {
      const session = await app.sessions.create({ summary: "dispatch test", flow: "quick" });
      await app.sessions.update(session.id, { status: "ready", stage: "implement" });

      // Stub dispatch to succeed -- the assertion is about the dispatched
      // flag wiring, not the real dispatch path.
      app.container.register({
        dispatchService: asValue({
          dispatch: async () => ({ ok: true, message: "stubbed-ok" }),
        }),
      });

      const result = await app.sessionHooks.mediateStageHandoff(session.id, {
        autoDispatch: true,
        source: "test",
      });

      expect(result.ok).toBe(true);
      expect(result.dispatched).toBe(true);
    }, 30_000);

    it("returns dispatched=false when autoDispatch is disabled", async () => {
      const session = await app.sessions.create({ summary: "no dispatch test", flow: "quick" });
      await app.sessions.update(session.id, { status: "ready", stage: "implement" });

      const result = await app.sessionHooks.mediateStageHandoff(session.id, {
        autoDispatch: false,
        source: "test",
      });

      expect(result.ok).toBe(true);
      expect(result.dispatched).toBe(false);
      expect(result.toStage).toBe("verify");
    });
  });

  describe("manual-gate handoff", async () => {
    it("fails when gate is manual and not forced", async () => {
      const session = await app.sessions.create({ summary: "manual test", flow: "bare" });
      await app.sessions.update(session.id, { status: "ready", stage: "work" });

      const result = await app.sessionHooks.mediateStageHandoff(session.id, { source: "test" });

      // advance() is called without force, so manual gate blocks it
      expect(result.ok).toBe(false);
      expect(result.message).toContain("manual gate");
    });
  });

  describe("flow completion", async () => {
    it("completes flow when at last stage", async () => {
      // autonomous flow has only one stage ("work" with auto gate)
      const session = await app.sessions.create({ summary: "completion test", flow: "autonomous" });
      await app.sessions.update(session.id, { status: "ready", stage: "work" });

      const result = await app.sessionHooks.mediateStageHandoff(session.id, { source: "test" });

      expect(result.ok).toBe(true);
      expect(result.flowCompleted).toBe(true);
      expect(result.fromStage).toBe("work");
      expect(result.toStage).toBeNull();

      const updated = await app.sessions.get(session.id);
      expect(updated?.status).toBe("completed");
    });

    it("advances through multiple stages to completion", async () => {
      // quick flow: implement -> verify -> pr -> merge
      const session = await app.sessions.create({ summary: "multi-stage test", flow: "quick" });
      await app.sessions.update(session.id, { status: "ready", stage: "implement" });

      // Step 1: implement -> verify
      const r1 = await app.sessionHooks.mediateStageHandoff(session.id, {
        autoDispatch: false,
        source: "test",
      });
      expect(r1.ok).toBe(true);
      expect(r1.toStage).toBe("verify");
      expect(r1.flowCompleted).toBeFalsy();

      // Step 2: verify -> pr
      const r2 = await app.sessionHooks.mediateStageHandoff(session.id, {
        autoDispatch: false,
        source: "test",
      });
      expect(r2.ok).toBe(true);
      expect(r2.toStage).toBe("pr");

      // Step 3: pr -> merge
      const r3 = await app.sessionHooks.mediateStageHandoff(session.id, {
        autoDispatch: false,
        source: "test",
      });
      expect(r3.ok).toBe(true);
      expect(r3.toStage).toBe("merge");

      // Step 4: merge -> completed
      const r4 = await app.sessionHooks.mediateStageHandoff(session.id, {
        autoDispatch: false,
        source: "test",
      });
      expect(r4.ok).toBe(true);
      expect(r4.flowCompleted).toBe(true);

      const final = await app.sessions.get(session.id);
      expect(final?.status).toBe("completed");
    });
  });

  describe("verification blocking", async () => {
    it("blocks handoff when unresolved todos exist", async () => {
      const session = await app.sessions.create({ summary: "todo block test", flow: "quick" });
      await app.sessions.update(session.id, { status: "ready", stage: "implement" });

      // Add an unresolved todo
      await app.todos.add(session.id, "Must resolve this before advancing");

      const result = await app.sessionHooks.mediateStageHandoff(session.id, { source: "test" });

      expect(result.ok).toBe(false);
      expect(result.blockedByVerification).toBe(true);
      expect(result.fromStage).toBe("implement");

      // Session should be blocked
      const updated = await app.sessions.get(session.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.breakpoint_reason).toContain("Verification failed");

      // Error message should be stored
      const msgs = await app.messages.list(session.id);
      expect(msgs.some((m) => m.content.includes("Advance blocked"))).toBe(true);
    });

    it("logs stage_handoff_blocked event on verification failure", async () => {
      const session = await app.sessions.create({ summary: "event block test", flow: "quick" });
      await app.sessions.update(session.id, { status: "ready", stage: "implement" });
      await app.todos.add(session.id, "Blocking todo");

      await app.sessionHooks.mediateStageHandoff(session.id, { source: "channel_report" });

      const events = await app.events.list(session.id);
      const blocked = events.find((e) => e.type === "stage_handoff_blocked");
      expect(blocked).toBeTruthy();
      expect(blocked!.data?.source).toBe("channel_report");
      expect(blocked!.data?.reason).toBe("verification_failed");
    });
  });

  describe("observability events", async () => {
    it("emits stage_handoff event on successful handoff", async () => {
      const session = await app.sessions.create({ summary: "event test", flow: "quick" });
      await app.sessions.update(session.id, { status: "ready", stage: "implement" });

      await app.sessionHooks.mediateStageHandoff(session.id, {
        autoDispatch: false,
        source: "channel_report",
      });

      const events = await app.events.list(session.id);
      const handoff = events.find((e) => e.type === "stage_handoff");
      expect(handoff).toBeTruthy();
      expect(handoff!.data?.from_stage).toBe("implement");
      expect(handoff!.data?.to_stage).toBe("verify");
      expect(handoff!.data?.source).toBe("channel_report");
    });

    it("emits stage_handoff event with flow_completed on last stage", async () => {
      const session = await app.sessions.create({ summary: "complete event test", flow: "autonomous" });
      await app.sessions.update(session.id, { status: "ready", stage: "work" });

      await app.sessionHooks.mediateStageHandoff(session.id, { source: "hook_status" });

      const events = await app.events.list(session.id);
      const handoff = events.find((e) => e.type === "stage_handoff");
      expect(handoff).toBeTruthy();
      expect(handoff!.data?.flow_completed).toBe(true);
      expect(handoff!.data?.source).toBe("hook_status");
    });
  });

  describe("error handling", async () => {
    it("returns error for missing session", async () => {
      const result = await app.sessionHooks.mediateStageHandoff("s-nonexistent", { source: "test" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("not found");
    });

    it("returns error when session has no stage", async () => {
      const session = await app.sessions.create({ summary: "no stage test", flow: "quick" });
      await app.sessions.update(session.id, { status: "ready", stage: null as any });

      const result = await app.sessionHooks.mediateStageHandoff(session.id, { source: "test" });
      expect(result.ok).toBe(false);
    });
  });

  // Bug B regression: the mediator must surface dispatch failures (both
  // `{ok:false}` returns and thrown errors) by writing a `dispatch_failed`
  // event and flipping the session to `failed`, mirroring
  // SessionDispatchListeners.markDispatchFailed exactly. Pre-fix the wrapper
  // (`safeAsync`) only logged thrown errors and `{ok:false}` returns were
  // indistinguishable from successful dispatches.
  describe("auto-dispatch failure surfacing (Bug B regression)", async () => {
    it("marks session failed when dispatch returns {ok:false}", async () => {
      const session = await app.sessions.create({ summary: "dispatch-ok-false test", flow: "quick" });
      await app.sessions.update(session.id, { status: "ready", stage: "implement" });

      // Stub dispatchService to return a non-throwing failure. Override is
      // picked up by the wired callback because it resolves
      // c.app.dispatchService at call time (post-Bug-A).
      app.container.register({
        dispatchService: asValue({
          dispatch: async () => ({ ok: false, message: "boom" }),
        }),
      });

      const result = await app.sessionHooks.mediateStageHandoff(session.id, { source: "test" });

      // Mediator advanced to verify, then attempted dispatch, then saw
      // {ok:false} and surfaced the failure. dispatched must reflect that.
      expect(result.ok).toBe(true); // advance succeeded; only the dispatch failed
      expect(result.toStage).toBe("verify");
      expect(result.dispatched).toBe(false);

      // Session flipped to failed with the underlying reason
      const updated = await app.sessions.get(session.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("boom");

      // dispatch_failed event was logged with the underlying reason
      const events = await app.events.list(session.id);
      const dispatchFailed = events.find((e) => e.type === "dispatch_failed");
      expect(dispatchFailed).toBeTruthy();
      expect(dispatchFailed!.data?.reason).toBe("boom");
    });

    it("marks session failed when dispatch throws", async () => {
      const session = await app.sessions.create({ summary: "dispatch-throw test", flow: "quick" });
      await app.sessions.update(session.id, { status: "ready", stage: "implement" });

      // Stub dispatchService to throw -- pre-fix safeAsync swallowed the
      // throw to logError without touching session state.
      app.container.register({
        dispatchService: asValue({
          dispatch: async () => {
            throw new Error("kaboom");
          },
        }),
      });

      const result = await app.sessionHooks.mediateStageHandoff(session.id, { source: "test" });

      expect(result.ok).toBe(true);
      expect(result.toStage).toBe("verify");
      expect(result.dispatched).toBe(false);

      const updated = await app.sessions.get(session.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("kaboom");

      const events = await app.events.list(session.id);
      const dispatchFailed = events.find((e) => e.type === "dispatch_failed");
      expect(dispatchFailed).toBeTruthy();
      expect(dispatchFailed!.data?.reason).toBe("kaboom");
    });

    it("does not clobber an already-terminal status (lenient guard)", async () => {
      // If another path beat us to terminal (e.g. session was cancelled mid
      // dispatch), markDispatchFailed must not overwrite that status.
      const session = await app.sessions.create({ summary: "lenient guard test", flow: "quick" });
      await app.sessions.update(session.id, { status: "ready", stage: "implement" });

      app.container.register({
        dispatchService: asValue({
          dispatch: async () => {
            // Simulate a concurrent terminal flip while dispatch is in flight.
            await app.sessions.update(session.id, {
              status: "cancelled" as any,
              error: "user cancelled",
            });
            return { ok: false, message: "boom-after-cancel" };
          },
        }),
      });

      await app.sessionHooks.mediateStageHandoff(session.id, { source: "test" });

      const updated = await app.sessions.get(session.id);
      expect(updated?.status).toBe("cancelled");
      expect(updated?.error).toBe("user cancelled");

      // The dispatch_failed event still gets logged for observability even
      // when the status flip is skipped.
      const events = await app.events.list(session.id);
      expect(events.some((e) => e.type === "dispatch_failed")).toBe(true);
    });
  });
});

// ── Integration: applyReport -> mediateStageHandoff ─────────────────────

describe("applyReport + mediateStageHandoff integration", async () => {
  it("report with shouldAdvance feeds into mediateStageHandoff correctly", async () => {
    const session = await app.sessions.create({ summary: "integration test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });

    // Step 1: applyReport determines shouldAdvance
    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "Code written",
      filesChanged: ["src/feature.ts"],
      commits: ["abc123"],
    };
    const result = await app.sessionHooks.applyReport(session.id, report);
    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);

    // Apply updates as the conductor would
    await app.sessions.update(session.id, result.updates);

    // Step 2: mediateStageHandoff handles the actual transition
    const handoff = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false, // disable dispatch for test predictability
      source: "channel_report",
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.fromStage).toBe("implement");
    expect(handoff.toStage).toBe("verify");

    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("report on manual gate does not trigger handoff", async () => {
    const session = await app.sessions.create({ summary: "manual integration", flow: "bare" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });

    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "work",
      summary: "Done",
      filesChanged: [],
      commits: [],
    };
    const result = await app.sessionHooks.applyReport(session.id, report);

    // Manual gate: shouldAdvance is falsy -- conductor should NOT call mediateStageHandoff
    expect(result.shouldAdvance).toBeFalsy();
  });

  it("clears stale error before advancing so auto-gate passes", async () => {
    const session = await app.sessions.create({ summary: "stale error handoff", flow: "quick" });
    // Simulate: session has a stale error from a previous failed attempt
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      error: "previous failure from retry",
    });

    // Step 1: applyReport on successful completion
    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "Code written on retry",
      filesChanged: ["src/feature.ts"],
      commits: ["abc123"],
    };
    const result = await app.sessionHooks.applyReport(session.id, report);
    expect(result.shouldAdvance).toBe(true);
    expect(result.updates.error).toBeNull();

    // Step 2: Apply updates as conductor would
    await app.sessions.update(session.id, result.updates);

    // Step 3: Verify the error was cleared in the DB
    const afterUpdate = await app.sessions.get(session.id)!;
    expect(afterUpdate.error).toBeNull();

    // Step 4: mediateStageHandoff should succeed (gate passes with null error)
    const handoff = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.toStage).toBe("verify");
  });
});

// ── Integration: applyHookStatus -> mediateStageHandoff ─────────────────

describe("applyHookStatus + mediateStageHandoff integration", async () => {
  it("SessionEnd on auto-gate session feeds into mediateStageHandoff", async () => {
    const session = await app.sessions.create({ summary: "hook integration", flow: "autonomous" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });
    const fresh = await app.sessions.get(session.id)!;

    // Step 1: applyHookStatus determines shouldAdvance
    const result = await app.sessionHooks.applyHookStatus(fresh, "SessionEnd", {});
    expect(result.shouldAdvance).toBe(true);

    // Apply updates
    if (result.updates) await app.sessions.update(session.id, result.updates);

    // Step 2: mediateStageHandoff completes the flow
    const handoff = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: result.shouldAutoDispatch,
      source: "hook_status",
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.flowCompleted).toBe(true);

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });
});

// ── Integration via conductor HTTP ──────────────────────────────────────

const TEST_PORT = 19197;

describe("mediateStageHandoff via conductor HTTP", async () => {
  let server: { stop(): void } | null = null;

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

  it("channel report on auto-gate stage triggers handoff to next stage", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    // Stub the launch path to a no-op success so the conductor->mediate
    // chain exercises in isolation from the real dispatcher.
    app.container.register({
      dispatchService: asValue({
        dispatch: async (id: string) => {
          await app.sessions.update(id, { session_id: `ark-s-${id}`, status: "running" });
          return { ok: true, message: "stubbed-conductor-dispatch" };
        },
      }),
    });

    const session = await app.sessions.create({ summary: "conductor handoff test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });

    const resp = await fetch(`http://localhost:${TEST_PORT}/api/channel/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "completed",
        sessionId: session.id,
        stage: "implement",
        summary: "Feature implemented",
        filesChanged: ["src/feature.ts"],
        commits: ["commit1"],
      }),
    });

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    // Status is "running" because auto-dispatch is now properly awaited
    expect(updated?.status).toBe("running");

    // Verify stage_handoff event was logged
    const events = await app.events.list(session.id);
    const handoff = events.find((e) => e.type === "stage_handoff");
    expect(handoff).toBeTruthy();
    expect(handoff!.data?.from_stage).toBe("implement");
    expect(handoff!.data?.to_stage).toBe("verify");
    expect(handoff!.data?.source).toBe("channel_report");
  });

  it("hook SessionEnd on auto-gate triggers handoff via conductor", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = await app.sessions.create({ summary: "hook handoff test", flow: "autonomous" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });

    const resp = await fetch(`http://localhost:${TEST_PORT}/hooks/status?session=${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SessionEnd" }),
    });

    expect(resp.status).toBe(200);

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");

    // Verify stage_handoff event was logged
    const events = await app.events.list(session.id);
    const handoff = events.find((e) => e.type === "stage_handoff");
    expect(handoff).toBeTruthy();
    expect(handoff!.data?.flow_completed).toBe(true);
    expect(handoff!.data?.source).toBe("hook_status");
  });

  it("channel report on manual-gate does not trigger handoff", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = await app.sessions.create({ summary: "manual conductor test", flow: "bare" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });

    const resp = await fetch(`http://localhost:${TEST_PORT}/api/channel/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "completed",
        sessionId: session.id,
        stage: "work",
        summary: "Done",
        filesChanged: [],
        commits: [],
      }),
    });

    expect(resp.status).toBe(200);

    // Manual gate: session transitions to `blocked` (agent exited,
    // awaiting human Approve/Reject); no handoff fires.
    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("blocked");

    // No stage_handoff event should exist
    const events = await app.events.list(session.id);
    const handoff = events.find((e) => e.type === "stage_handoff");
    expect(handoff).toBeFalsy();
  });
});
