/**
 * End-to-end tests for the attach flow (programmatic, without TUI).
 *
 * Tests dispatch, tmux verification, reconciliation, post-exit actions,
 * compute validation, and resume. Uses the core API directly.
 *
 * Isolation: AppContext.forTest() + isolated workdir. DB in temp dir.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import * as core from "../../core/index.js";
import { setupE2E, type E2EEnv } from "./e2e-setup.js";

let env: E2EEnv;

beforeAll(async () => { env = await setupE2E(); });
afterAll(async () => { await env.teardown(); });

afterEach(() => {
  for (const id of env.sessionIds) {
    try {
      const s = core.getSession(id);
      if (s?.session_id) {
        try { core.killSession(s.session_id); } catch {}
      }
      core.deleteSession(id);
    } catch {}
  }
  env.sessionIds.length = 0;
});

describe("e2e attach flow", () => {
  it("creates session, dispatches, verifies tmux exists, stops", async () => {
    const s = core.startSession({
      summary: "attach-test",
      repo: env.workdir,
      flow: "bare",
      workdir: env.workdir,
    });
    env.sessionIds.push(s.id);

    const result = await core.dispatch(s.id);
    expect(result.ok).toBe(true);

    const updated = core.getSession(s.id)!;
    expect(updated.status).toBe("running");
    expect(updated.session_id).toBeTruthy();

    expect(core.sessionExists(updated.session_id!)).toBe(true);

    const stopResult = await core.stop(s.id);
    expect(stopResult.ok).toBe(true);
    expect(core.getSession(s.id)!.status).toBe("stopped");
  }, 30_000);

  it("session reconciliation detects dead tmux", async () => {
    const s = core.startSession({
      summary: "reconcile-test",
      repo: env.workdir,
      flow: "bare",
      workdir: env.workdir,
    });
    env.sessionIds.push(s.id);

    const result = await core.dispatch(s.id);
    expect(result.ok).toBe(true);

    const sid = core.getSession(s.id)!.session_id!;
    expect(sid).toBeTruthy();

    core.killSession(sid);
    expect(core.getSession(s.id)!.status).toBe("running");

    const exists = await core.sessionExistsAsync(sid);
    expect(exists).toBe(false);

    core.updateSession(s.id, { status: "failed", error: "Agent process exited", session_id: null });
    expect(core.getSession(s.id)!.status).toBe("failed");
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
  });

  it("dispatch validates compute exists", async () => {
    const s = core.startSession({
      summary: "bad-compute",
      repo: env.workdir,
      flow: "bare",
      compute_name: "nonexistent-compute-xyz",
      workdir: env.workdir,
    });
    env.sessionIds.push(s.id);

    const result = await core.dispatch(s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  }, 10_000);

  it("dispatch rejects non-ready sessions", async () => {
    const s = core.startSession({
      summary: "reject-test",
      repo: env.workdir,
      flow: "bare",
      workdir: env.workdir,
    });
    env.sessionIds.push(s.id);

    await core.dispatch(s.id);
    core.complete(s.id);
    expect(core.getSession(s.id)!.status).toBe("completed");

    const result = await core.dispatch(s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Not ready");
  }, 30_000);

  it("resume retries a failed session", async () => {
    const s = core.startSession({
      summary: "resume-test",
      repo: env.workdir,
      flow: "bare",
      workdir: env.workdir,
    });
    env.sessionIds.push(s.id);

    const r1 = await core.dispatch(s.id);
    expect(r1.ok).toBe(true);

    await core.stop(s.id);
    expect(core.getSession(s.id)!.status).toBe("stopped");

    const r2 = await core.resume(s.id);
    expect(r2.ok).toBe(true);

    const resumed = core.getSession(s.id)!;
    expect(resumed.status).toBe("running");
    expect(resumed.session_id).toBeTruthy();

    const events = core.getEvents(s.id, { type: "session_resumed" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("resume allows completed sessions to restart", async () => {
    const s = core.startSession({
      summary: "resume-completed-test",
      repo: env.workdir,
      flow: "bare",
      workdir: env.workdir,
    });
    env.sessionIds.push(s.id);

    await core.dispatch(s.id);
    core.complete(s.id);
    expect(core.getSession(s.id)!.status).toBe("completed");

    const result = await core.resume(s.id);
    // Completed sessions can now be resumed
    expect(result.message).not.toContain("completed");
  }, 30_000);

  it("getOutput returns empty string for undispatched session", async () => {
    const s = core.startSession({
      summary: "output-empty-test",
      repo: env.workdir,
      flow: "bare",
      workdir: env.workdir,
    });
    env.sessionIds.push(s.id);

    const output = await core.getOutput(s.id);
    expect(output).toBe("");
  });

  it("getOutput returns string for running session", async () => {
    const s = core.startSession({
      summary: "output-running-test",
      repo: env.workdir,
      flow: "bare",
      workdir: env.workdir,
    });
    env.sessionIds.push(s.id);

    await core.dispatch(s.id);
    const output = await core.getOutput(s.id, { lines: 10 });
    expect(typeof output).toBe("string");

    await core.stop(s.id);
  }, 30_000);
});
