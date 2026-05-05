/**
 * Stage-tracking state divergence guard.
 *
 * Two stores track "which stage is active right now":
 *   1. session.stage -- the conductor's authoritative view, updated by advance()
 *   2. payload.stage / report.stage -- the stage the runtime was provisioned for,
 *      stamped on every hook and outbound message by the runtime.
 *
 * When they agree, everything works. When they diverge (typically because the
 * state machine advanced mid-flight while the old stage's agent is still alive
 * on its compute and fires late hooks / late reports), the pre-fix code would:
 *
 *   - look up stage gate rules using session.stage (the NEW stage)
 *   - decide the new gate's status transition was appropriate for the OLD hook
 *   - apply that transition, overwriting the new stage's running state
 *
 * Concrete repro (#435-adjacent): session was on "plan" (auto), state machine
 * advanced to "implement" (manual), the plan agent's delayed SessionEnd fires.
 * statusMap is indexed by `implement`'s gate (manual) -> SessionEnd stays
 * `running` and NO advance fires -- but the plan agent is gone and the
 * implement agent has its own fresh lifecycle. More severe: when both stages
 * are auto, the stale SessionEnd sets `shouldAdvance=true` and advance()
 * reads session.stage="implement" and advances AWAY from a still-running
 * implement agent.
 *
 * Fix: when payload.stage (or report.stage) is set AND differs from
 * session.stage, the event is stale. Log it for timeline attribution, then
 * return without any state transitions. The active agent's lifecycle is not
 * touched by ghost events from a prior stage.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
});

describe("applyHookStatus stale-hook guard", () => {
  it("suppresses state transitions when payload.stage differs from session.stage", async () => {
    const session = await app.sessions.create({ summary: "stale SessionEnd repro", flow: "quick" });
    // Session has moved on to `merge`, but the `implement` agent is still
    // alive on its compute and finally fires SessionEnd.
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "merge",
    });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionEnd", {
      stage: "implement",
      session_id: session.id,
    });

    // No status change. No advance. No auto-dispatch.
    expect(result.newStatus).toBeUndefined();
    expect(result.updates?.status).toBeUndefined();
    expect(result.shouldAdvance).toBeFalsy();
    expect(result.shouldAutoDispatch).toBeFalsy();
  });

  it("still logs a hook_status event for timeline attribution on stale hooks", async () => {
    const session = await app.sessions.create({ summary: "stale event still logged", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "merge",
    });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionEnd", {
      stage: "implement",
      session_id: session.id,
    });

    const hookEvent = result.events?.find((e) => e.type === "hook_status");
    expect(hookEvent).toBeTruthy();
    // Stamped with the stage the hook was actually for (implement), not the
    // conductor's current view (merge).
    expect(hookEvent?.opts?.stage).toBe("implement");
  });

  it("does not suppress when payload.stage matches session.stage (happy path)", async () => {
    const session = await app.sessions.create({ summary: "happy path not suppressed", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
    });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionEnd", {
      stage: "implement",
      session_id: session.id,
    });

    // Matching stage -- normal pipeline runs. For a running auto-gate session
    // SessionEnd produces a real status decision (ready, failed due to
    // no-commits, etc.) rather than undefined.
    expect(result.newStatus).toBeDefined();
  });

  it("does not suppress when payload.stage is missing (legacy runtime fallback)", async () => {
    // Legacy runtimes that don't stamp payload.stage fall through to
    // session.stage for everything. This is the pre-fix behaviour and
    // must stay that way.
    const session = await app.sessions.create({ summary: "no payload stage", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
    });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionEnd", {
      session_id: session.id,
      // no `stage` field -- legacy runtime
    });

    expect(result.newStatus).toBeDefined();
  });
});

describe("applyReport stale-report guard", () => {
  it("suppresses state transitions when report.stage differs from session.stage", async () => {
    const session = await app.sessions.create({ summary: "stale report repro", flow: "quick" });
    // The conductor has already advanced past `implement` to `merge`, but
    // the old `implement` agent finally sends its completion report.
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "merge",
    });

    const result = await app.sessionHooks.applyReport(session.id, {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "done with implement",
      filesChanged: [],
      commits: [],
    });

    // No status flip, no advance, no auto-dispatch.
    expect(result.updates.status).toBeUndefined();
    expect(result.shouldAdvance).toBeFalsy();
    expect(result.shouldAutoDispatch).toBeFalsy();
  });

  it("still records the report on the timeline when stale", async () => {
    const session = await app.sessions.create({ summary: "stale report logged", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "merge",
    });

    const result = await app.sessionHooks.applyReport(session.id, {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "done with implement",
      filesChanged: [],
      commits: [],
    });

    const reportEvent = result.logEvents?.find((e) => e.type === "agent_completed");
    expect(reportEvent).toBeTruthy();
    // Stamped with the stage the agent claimed, not session.stage.
    expect(reportEvent?.opts?.stage).toBe("implement");
  });

  it("processes normally when report.stage matches session.stage", async () => {
    const session = await app.sessions.create({ summary: "matching report stage", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: null,
      branch: null,
    });

    const result = await app.sessionHooks.applyReport(session.id, {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "done",
      filesChanged: [],
      commits: [],
    });

    // Auto-gate completion sets status=ready and triggers advance.
    expect(result.updates.status).toBe("ready");
    expect(result.shouldAdvance).toBe(true);
  });

  it("processes normally when report.stage is empty (legacy agent)", async () => {
    // Legacy agents without ARK_STAGE stamp an empty string. Empty == missing
    // == legacy == fall through to session.stage semantics.
    const session = await app.sessions.create({ summary: "empty report stage", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: null,
      branch: null,
    });

    const result = await app.sessionHooks.applyReport(session.id, {
      type: "completed",
      sessionId: session.id,
      stage: "",
      summary: "done",
      filesChanged: [],
      commits: [],
    });

    expect(result.updates.status).toBe("ready");
  });
});
