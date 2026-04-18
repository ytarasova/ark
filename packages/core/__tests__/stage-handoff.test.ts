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
import { AppContext, getApp, setApp, clearApp } from "../app.js";
import { mediateStageHandoff, applyReport, applyHookStatus, advance } from "../services/session-orchestration.js";
import { startConductor } from "../conductor/conductor.js";
import type { OutboundMessage } from "../conductor/channel-types.js";
import { allocatePort } from "./helpers/test-env.js";

let app: AppContext;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterEach(async () => {
  // no-op -- beforeEach handles cleanup
});

// ── Unit tests for mediateStageHandoff ────────────────────────────────────

describe("mediateStageHandoff", () => {
  describe("auto-gate handoff", () => {
    it("advances from current stage to next stage", async () => {
      const session = app.sessions.create({ summary: "handoff test", flow: "quick" });
      app.sessions.update(session.id, { status: "ready", stage: "implement" });

      const result = await mediateStageHandoff(app, session.id, { source: "test" });

      expect(result.ok).toBe(true);
      expect(result.fromStage).toBe("implement");
      expect(result.toStage).toBe("verify");

      const updated = app.sessions.get(session.id);
      expect(updated?.stage).toBe("verify");
      // Status is "running" because autoDispatch defaults to true and dispatch is now awaited
      expect(updated?.status).toBe("running");
    });

    it("returns dispatched=true when autoDispatch is enabled", async () => {
      const session = app.sessions.create({ summary: "dispatch test", flow: "quick" });
      app.sessions.update(session.id, { status: "ready", stage: "implement" });

      const result = await mediateStageHandoff(app, session.id, {
        autoDispatch: true,
        source: "test",
      });

      expect(result.ok).toBe(true);
      expect(result.dispatched).toBe(true);
    });

    it("returns dispatched=false when autoDispatch is disabled", async () => {
      const session = app.sessions.create({ summary: "no dispatch test", flow: "quick" });
      app.sessions.update(session.id, { status: "ready", stage: "implement" });

      const result = await mediateStageHandoff(app, session.id, {
        autoDispatch: false,
        source: "test",
      });

      expect(result.ok).toBe(true);
      expect(result.dispatched).toBe(false);
      expect(result.toStage).toBe("verify");
    });
  });

  describe("manual-gate handoff", () => {
    it("fails when gate is manual and not forced", async () => {
      const session = app.sessions.create({ summary: "manual test", flow: "bare" });
      app.sessions.update(session.id, { status: "ready", stage: "work" });

      const result = await mediateStageHandoff(app, session.id, { source: "test" });

      // advance() is called without force, so manual gate blocks it
      expect(result.ok).toBe(false);
      expect(result.message).toContain("manual gate");
    });
  });

  describe("flow completion", () => {
    it("completes flow when at last stage", async () => {
      // autonomous flow has only one stage ("work" with auto gate)
      const session = app.sessions.create({ summary: "completion test", flow: "autonomous" });
      app.sessions.update(session.id, { status: "ready", stage: "work" });

      const result = await mediateStageHandoff(app, session.id, { source: "test" });

      expect(result.ok).toBe(true);
      expect(result.flowCompleted).toBe(true);
      expect(result.fromStage).toBe("work");
      expect(result.toStage).toBeNull();

      const updated = app.sessions.get(session.id);
      expect(updated?.status).toBe("completed");
    });

    it("advances through multiple stages to completion", async () => {
      // quick flow: implement -> verify -> pr -> merge
      const session = app.sessions.create({ summary: "multi-stage test", flow: "quick" });
      app.sessions.update(session.id, { status: "ready", stage: "implement" });

      // Step 1: implement -> verify
      const r1 = await mediateStageHandoff(app, session.id, {
        autoDispatch: false,
        source: "test",
      });
      expect(r1.ok).toBe(true);
      expect(r1.toStage).toBe("verify");
      expect(r1.flowCompleted).toBeFalsy();

      // Step 2: verify -> pr
      const r2 = await mediateStageHandoff(app, session.id, {
        autoDispatch: false,
        source: "test",
      });
      expect(r2.ok).toBe(true);
      expect(r2.toStage).toBe("pr");

      // Step 3: pr -> merge
      const r3 = await mediateStageHandoff(app, session.id, {
        autoDispatch: false,
        source: "test",
      });
      expect(r3.ok).toBe(true);
      expect(r3.toStage).toBe("merge");

      // Step 4: merge -> completed
      const r4 = await mediateStageHandoff(app, session.id, {
        autoDispatch: false,
        source: "test",
      });
      expect(r4.ok).toBe(true);
      expect(r4.flowCompleted).toBe(true);

      const final = app.sessions.get(session.id);
      expect(final?.status).toBe("completed");
    });
  });

  describe("verification blocking", () => {
    it("blocks handoff when unresolved todos exist", async () => {
      const session = app.sessions.create({ summary: "todo block test", flow: "quick" });
      app.sessions.update(session.id, { status: "ready", stage: "implement" });

      // Add an unresolved todo
      app.todos.add(session.id, "Must resolve this before advancing");

      const result = await mediateStageHandoff(app, session.id, { source: "test" });

      expect(result.ok).toBe(false);
      expect(result.blockedByVerification).toBe(true);
      expect(result.fromStage).toBe("implement");

      // Session should be blocked
      const updated = app.sessions.get(session.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.breakpoint_reason).toContain("Verification failed");

      // Error message should be stored
      const msgs = app.messages.list(session.id);
      expect(msgs.some((m) => m.content.includes("Advance blocked"))).toBe(true);
    });

    it("logs stage_handoff_blocked event on verification failure", async () => {
      const session = app.sessions.create({ summary: "event block test", flow: "quick" });
      app.sessions.update(session.id, { status: "ready", stage: "implement" });
      app.todos.add(session.id, "Blocking todo");

      await mediateStageHandoff(app, session.id, { source: "channel_report" });

      const events = app.events.list(session.id);
      const blocked = events.find((e) => e.type === "stage_handoff_blocked");
      expect(blocked).toBeTruthy();
      expect(blocked!.data?.source).toBe("channel_report");
      expect(blocked!.data?.reason).toBe("verification_failed");
    });
  });

  describe("observability events", () => {
    it("emits stage_handoff event on successful handoff", async () => {
      const session = app.sessions.create({ summary: "event test", flow: "quick" });
      app.sessions.update(session.id, { status: "ready", stage: "implement" });

      await mediateStageHandoff(app, session.id, {
        autoDispatch: false,
        source: "channel_report",
      });

      const events = app.events.list(session.id);
      const handoff = events.find((e) => e.type === "stage_handoff");
      expect(handoff).toBeTruthy();
      expect(handoff!.data?.from_stage).toBe("implement");
      expect(handoff!.data?.to_stage).toBe("verify");
      expect(handoff!.data?.source).toBe("channel_report");
    });

    it("emits stage_handoff event with flow_completed on last stage", async () => {
      const session = app.sessions.create({ summary: "complete event test", flow: "autonomous" });
      app.sessions.update(session.id, { status: "ready", stage: "work" });

      await mediateStageHandoff(app, session.id, { source: "hook_status" });

      const events = app.events.list(session.id);
      const handoff = events.find((e) => e.type === "stage_handoff");
      expect(handoff).toBeTruthy();
      expect(handoff!.data?.flow_completed).toBe(true);
      expect(handoff!.data?.source).toBe("hook_status");
    });
  });

  describe("error handling", () => {
    it("returns error for missing session", async () => {
      const result = await mediateStageHandoff(app, "s-nonexistent", { source: "test" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("not found");
    });

    it("returns error when session has no stage", async () => {
      const session = app.sessions.create({ summary: "no stage test", flow: "quick" });
      app.sessions.update(session.id, { status: "ready", stage: null as any });

      const result = await mediateStageHandoff(app, session.id, { source: "test" });
      expect(result.ok).toBe(false);
    });
  });
});

// ── Integration: applyReport -> mediateStageHandoff ─────────────────────

describe("applyReport + mediateStageHandoff integration", () => {
  it("report with shouldAdvance feeds into mediateStageHandoff correctly", async () => {
    const session = app.sessions.create({ summary: "integration test", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    // Step 1: applyReport determines shouldAdvance
    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "Code written",
      filesChanged: ["src/feature.ts"],
      commits: ["abc123"],
    };
    const result = applyReport(app, session.id, report);
    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);

    // Apply updates as the conductor would
    app.sessions.update(session.id, result.updates);

    // Step 2: mediateStageHandoff handles the actual transition
    const handoff = await mediateStageHandoff(app, session.id, {
      autoDispatch: false, // disable dispatch for test predictability
      source: "channel_report",
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.fromStage).toBe("implement");
    expect(handoff.toStage).toBe("verify");

    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("report on manual gate does not trigger handoff", async () => {
    const session = app.sessions.create({ summary: "manual integration", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "work",
      summary: "Done",
      filesChanged: [],
      commits: [],
    };
    const result = applyReport(app, session.id, report);

    // Manual gate: shouldAdvance is falsy -- conductor should NOT call mediateStageHandoff
    expect(result.shouldAdvance).toBeFalsy();
  });

  it("clears stale error before advancing so auto-gate passes", async () => {
    const session = app.sessions.create({ summary: "stale error handoff", flow: "quick" });
    // Simulate: session has a stale error from a previous failed attempt
    app.sessions.update(session.id, {
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
    const result = applyReport(app, session.id, report);
    expect(result.shouldAdvance).toBe(true);
    expect(result.updates.error).toBeNull();

    // Step 2: Apply updates as conductor would
    app.sessions.update(session.id, result.updates);

    // Step 3: Verify the error was cleared in the DB
    const afterUpdate = app.sessions.get(session.id)!;
    expect(afterUpdate.error).toBeNull();

    // Step 4: mediateStageHandoff should succeed (gate passes with null error)
    const handoff = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.toStage).toBe("verify");
  });
});

// ── Integration: applyHookStatus -> mediateStageHandoff ─────────────────

describe("applyHookStatus + mediateStageHandoff integration", () => {
  it("SessionEnd on auto-gate session feeds into mediateStageHandoff", async () => {
    const session = app.sessions.create({ summary: "hook integration", flow: "autonomous" });
    app.sessions.update(session.id, { status: "running", stage: "work" });
    const fresh = app.sessions.get(session.id)!;

    // Step 1: applyHookStatus determines shouldAdvance
    const result = applyHookStatus(app, fresh, "SessionEnd", {});
    expect(result.shouldAdvance).toBe(true);

    // Apply updates
    if (result.updates) app.sessions.update(session.id, result.updates);

    // Step 2: mediateStageHandoff completes the flow
    const handoff = await mediateStageHandoff(app, session.id, {
      autoDispatch: result.shouldAutoDispatch,
      source: "hook_status",
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.flowCompleted).toBe(true);

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });
});

// ── Integration via conductor HTTP ──────────────────────────────────────

let TEST_PORT: number;

describe("mediateStageHandoff via conductor HTTP", () => {
  let server: { stop(): void } | null = null;

  beforeEach(async () => {
    TEST_PORT = await allocatePort();
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

  it("channel report on auto-gate stage triggers handoff to next stage", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = app.sessions.create({ summary: "conductor handoff test", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

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

    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    // Status is "running" because auto-dispatch is now properly awaited
    expect(updated?.status).toBe("running");

    // Verify stage_handoff event was logged
    const events = app.events.list(session.id);
    const handoff = events.find((e) => e.type === "stage_handoff");
    expect(handoff).toBeTruthy();
    expect(handoff!.data?.from_stage).toBe("implement");
    expect(handoff!.data?.to_stage).toBe("verify");
    expect(handoff!.data?.source).toBe("channel_report");
  });

  it("hook SessionEnd on auto-gate triggers handoff via conductor", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = app.sessions.create({ summary: "hook handoff test", flow: "autonomous" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const resp = await fetch(`http://localhost:${TEST_PORT}/hooks/status?session=${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SessionEnd" }),
    });

    expect(resp.status).toBe(200);

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");

    // Verify stage_handoff event was logged
    const events = app.events.list(session.id);
    const handoff = events.find((e) => e.type === "stage_handoff");
    expect(handoff).toBeTruthy();
    expect(handoff!.data?.flow_completed).toBe(true);
    expect(handoff!.data?.source).toBe("hook_status");
  });

  it("channel report on manual-gate does not trigger handoff", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = app.sessions.create({ summary: "manual conductor test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

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

    // Manual gate: session stays running, no handoff
    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("running");

    // No stage_handoff event should exist
    const events = app.events.list(session.id);
    const handoff = events.find((e) => e.type === "stage_handoff");
    expect(handoff).toBeFalsy();
  });
});
