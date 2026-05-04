/**
 * Terminal-status guard in applyHookStatus (#435).
 *
 * Once a session reaches `failed` / `completed` / `stopped`, late-arriving
 * hook events MUST NOT flip the row back to a non-terminal status. The
 * production repro:
 *
 *   1. status-poller false-positive on claude-agent (which uses
 *      /process/spawn, not tmux) marks the session "completed" within
 *      ~3s of launch.
 *   2. mediateStageHandoff runs the action chain on a session whose
 *      agent never actually got to do work; auto_merge fails and
 *      markDispatchFailedShared sets status="failed".
 *   3. ~5 minutes later the EC2 agent finishes and emits SessionEnd.
 *      `statusMap[SessionEnd] = "ready"` (auto-gate) and the OLD guard
 *      only blocked "failed -> running" -- so "failed -> ready" silently
 *      un-failed the row, leaving status="ready" alongside an error
 *      message and a dispatch_failed event. UI showed PENDING + "Errors".
 *
 * This test pins the guard: SessionEnd arriving on an already-failed
 * session must not change status.
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

describe("applyHookStatus terminal-status guard (#435)", () => {
  it("does not flip status from failed back to ready on a late SessionEnd", async () => {
    const session = await app.sessions.create({ summary: "late-hook repro", flow: "quick" });
    // Reproduce the production state: action chain has already failed,
    // session.status="failed" with error set, stage advanced to merge.
    await app.sessions.update(session.id, {
      status: "failed",
      stage: "merge",
      error: "Action 'auto_merge' failed: Session has no PR URL -- run create_pr first",
    });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionEnd", {});

    // The guard MUST suppress the status transition. Hook handler reads
    // result.newStatus to decide whether to write session.status.
    expect(result.newStatus).toBeUndefined();
    expect(result.updates?.status).toBeUndefined();

    // shouldAdvance must also stay off -- the SessionEnd-running branch
    // gates on session.status === "running", so a failed session does
    // not trigger another mediate cycle.
    expect(result.shouldAdvance).toBeFalsy();
  });

  it("does not flip status from completed back to ready on a late SessionEnd", async () => {
    const session = await app.sessions.create({ summary: "late-hook completed", flow: "quick" });
    await app.sessions.update(session.id, { status: "completed", stage: "pr" });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionEnd", {});

    expect(result.newStatus).toBeUndefined();
    expect(result.updates?.status).toBeUndefined();
  });

  it("does not flip status from stopped back to running on a late SessionStart", async () => {
    const session = await app.sessions.create({ summary: "late-hook stopped", flow: "quick" });
    await app.sessions.update(session.id, { status: "stopped", stage: "implement" });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionStart", {});

    expect(result.newStatus).toBeUndefined();
    expect(result.updates?.status).toBeUndefined();
  });

  it("still allows running -> ready on SessionEnd for an actively-running session", async () => {
    // Sanity: the guard must not regress the happy path. A SessionEnd
    // on a `running` session in auto-gate should still flip to ready
    // (or proceed through the auto-commit branch). We just confirm
    // the guard didn't suppress the transition.
    const session = await app.sessions.create({ summary: "happy-path", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionEnd", {});

    // running + auto-gate -> SessionEnd should set newStatus to "ready"
    // (subject to the no-new-commits sub-branch which can downgrade to
    // "failed"). Either way the guard didn't strip newStatus to undefined.
    expect(result.newStatus).toBeDefined();
  });
});
