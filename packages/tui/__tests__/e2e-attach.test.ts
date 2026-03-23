/**
 * End-to-end tests for the attach flow (programmatic, without TUI).
 *
 * Tests dispatch, tmux verification, reconciliation, post-exit actions,
 * compute validation, and resume. Uses the core API directly.
 *
 * State isolation: ARK_TEST_DIR is set by bunfig.toml preload (packages/test-setup.ts).
 * Tmux sessions are global - use unique names and clean up in afterEach.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as core from "../../core/index.js";

// Track resources for cleanup
const sessionIds: string[] = [];

afterEach(async () => {
  for (const id of sessionIds) {
    try {
      const s = core.getSession(id);
      if (s?.session_id) {
        try { core.killSession(s.session_id); } catch { /* already gone */ }
      }
      core.deleteSession(id);
    } catch { /* already gone */ }
  }
  sessionIds.length = 0;
});

describe("e2e attach flow", () => {
  it("creates session, dispatches, verifies tmux exists, stops", async () => {
    const s = core.startSession({
      summary: "attach-test",
      repo: process.cwd(),
      flow: "bare",
    });
    sessionIds.push(s.id);

    // Dispatch
    const result = await core.dispatch(s.id);
    expect(result.ok).toBe(true);

    const updated = core.getSession(s.id)!;
    expect(updated.status).toBe("running");
    expect(updated.session_id).toBeTruthy();

    // Verify tmux session exists
    expect(core.sessionExists(updated.session_id!)).toBe(true);

    // Verify we can capture output (may be empty initially)
    const output = core.capturePane(updated.session_id!, { lines: 5 });
    expect(typeof output).toBe("string");

    // Stop
    const stopResult = core.stop(s.id);
    expect(stopResult.ok).toBe(true);
    expect(core.getSession(s.id)!.status).toBe("failed");
  }, 30_000);

  it("session reconciliation detects dead tmux", async () => {
    const s = core.startSession({
      summary: "reconcile-test",
      repo: process.cwd(),
      flow: "bare",
    });
    sessionIds.push(s.id);

    const result = await core.dispatch(s.id);
    expect(result.ok).toBe(true);

    const sid = core.getSession(s.id)!.session_id!;
    expect(sid).toBeTruthy();

    // Kill tmux directly (simulating crash)
    core.killSession(sid);

    // DB still says running
    expect(core.getSession(s.id)!.status).toBe("running");

    // Run reconciliation (same logic as useStore)
    const exists = await core.sessionExistsAsync(sid);
    expect(exists).toBe(false);

    // Mark as failed (what useStore does)
    core.updateSession(s.id, { status: "failed", error: "Agent process exited", session_id: null });
    expect(core.getSession(s.id)!.status).toBe("failed");
    expect(core.getSession(s.id)!.error).toContain("Agent process exited");
    expect(core.getSession(s.id)!.session_id).toBeNull();
  }, 30_000);

  it("post-exit action stores and retrieves correctly", async () => {
    const { setPostExitAction, getPostExitAction } = await import("../../tui/post-exit.js");

    setPostExitAction({ type: "tmux-attach", args: ["test-session"] });
    const action = getPostExitAction();
    expect(action).not.toBeNull();
    expect(action!.type).toBe("tmux-attach");
    expect(action!.args).toEqual(["test-session"]);
  });

  it("post-exit action supports ssh type", async () => {
    const { setPostExitAction, getPostExitAction } = await import("../../tui/post-exit.js");

    setPostExitAction({ type: "ssh", args: ["-t", "user@host", "tmux", "attach"] });
    const action = getPostExitAction();
    expect(action).not.toBeNull();
    expect(action!.type).toBe("ssh");
    expect(action!.args[0]).toBe("-t");
    expect(action!.args[1]).toBe("user@host");
  });

  it("dispatch validates compute exists", async () => {
    const s = core.startSession({
      summary: "bad-compute",
      repo: process.cwd(),
      flow: "bare",
      compute_name: "nonexistent-compute-xyz",
    });
    sessionIds.push(s.id);

    const result = await core.dispatch(s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  }, 10_000);

  it("dispatch rejects non-ready sessions", async () => {
    const s = core.startSession({
      summary: "reject-test",
      repo: process.cwd(),
      flow: "bare",
    });
    sessionIds.push(s.id);

    // Complete it first so it's no longer ready
    await core.dispatch(s.id);
    core.complete(s.id);
    expect(core.getSession(s.id)!.status).toBe("completed");

    // Try to dispatch completed session
    const result = await core.dispatch(s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Not ready");
  }, 30_000);

  it("resume retries a failed session", async () => {
    const s = core.startSession({
      summary: "resume-test",
      repo: process.cwd(),
      flow: "bare",
    });
    sessionIds.push(s.id);

    // Dispatch
    const r1 = await core.dispatch(s.id);
    expect(r1.ok).toBe(true);

    // Stop it
    core.stop(s.id);
    expect(core.getSession(s.id)!.status).toBe("failed");

    // Resume
    const r2 = await core.resume(s.id);
    expect(r2.ok).toBe(true);

    const resumed = core.getSession(s.id)!;
    expect(resumed.status).toBe("running");
    expect(resumed.session_id).toBeTruthy();

    // Verify resume event was logged
    const events = core.getEvents(s.id, { type: "session_resumed" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("resume rejects already-completed sessions", async () => {
    const s = core.startSession({
      summary: "resume-completed-test",
      repo: process.cwd(),
      flow: "bare",
    });
    sessionIds.push(s.id);

    await core.dispatch(s.id);
    core.complete(s.id);
    expect(core.getSession(s.id)!.status).toBe("completed");

    const result = await core.resume(s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Already completed");
  }, 30_000);

  it("getOutput returns empty string for undispatched session", () => {
    const s = core.startSession({
      summary: "output-empty-test",
      repo: process.cwd(),
      flow: "bare",
    });
    sessionIds.push(s.id);

    const output = core.getOutput(s.id);
    expect(output).toBe("");
  });

  it("getOutput returns string for running session", async () => {
    const s = core.startSession({
      summary: "output-running-test",
      repo: process.cwd(),
      flow: "bare",
    });
    sessionIds.push(s.id);

    await core.dispatch(s.id);
    const output = core.getOutput(s.id, { lines: 10 });
    expect(typeof output).toBe("string");

    core.stop(s.id);
  }, 30_000);

  it("full reconciliation loop matches useStore behavior", async () => {
    // Create two sessions, dispatch both, kill one tmux
    const s1 = core.startSession({ summary: "recon-1", repo: process.cwd(), flow: "bare" });
    const s2 = core.startSession({ summary: "recon-2", repo: process.cwd(), flow: "bare" });
    sessionIds.push(s1.id, s2.id);

    await core.dispatch(s1.id);
    await core.dispatch(s2.id);

    const s1Session = core.getSession(s1.id)!;
    const s2Session = core.getSession(s2.id)!;
    expect(s1Session.status).toBe("running");
    expect(s2Session.status).toBe("running");

    // Kill s1's tmux (simulating crash), leave s2 alive
    core.killSession(s1Session.session_id!);

    // Run reconciliation (same logic as useStore.reconcileSessions)
    const sessions = core.listSessions({ limit: 50 });
    for (const s of sessions) {
      if (s.status === "running" && s.session_id) {
        if (!core.sessionExists(s.session_id)) {
          let lastOutput = "";
          try {
            lastOutput = core.capturePane(s.session_id, { lines: 30 }).trim();
          } catch { /* session already gone */ }

          const error = lastOutput
            ? `Agent exited. Last output: ${lastOutput.split("\n").pop()?.slice(0, 100) ?? "unknown"}`
            : "Agent process exited";

          core.updateSession(s.id, { status: "failed", error, session_id: null });
          core.logEvent(s.id, "agent_exited", {
            stage: s.stage ?? undefined,
            actor: "system",
            data: { last_output: lastOutput.slice(0, 500) },
          });
        }
      }
    }

    // s1 should be failed (tmux was killed)
    expect(core.getSession(s1.id)!.status).toBe("failed");
    expect(core.getSession(s1.id)!.session_id).toBeNull();

    // s2 should still be running
    expect(core.getSession(s2.id)!.status).toBe("running");
    expect(core.getSession(s2.id)!.session_id).toBeTruthy();

    // Check agent_exited event on s1
    const events = core.getEvents(s1.id, { type: "agent_exited" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
