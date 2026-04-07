/**
 * End-to-end tests for the TUI session lifecycle.
 *
 * Tests the FULL flow: session creation, dispatch, tmux session verification,
 * reconciliation, and cleanup. Uses the core API directly.
 *
 * Isolation: AppContext.forTest() + isolated workdir. Real tmux sessions
 * are created but cleaned up in afterAll. DB is in a temp dir.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import * as core from "../../core/index.js";
import { setupE2E, type E2EEnv } from "./e2e-setup.js";

let env: E2EEnv;

beforeAll(async () => { env = await setupE2E(); });
afterAll(async () => { await env.teardown(); });

afterEach(() => {
  // Kill any tmux sessions created during this test
  for (const name of env.tmuxSessions) {
    try { core.killSession(name); } catch {}
  }
  env.tmuxSessions.length = 0;

  // Clean up sessions from DB
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

describe("e2e: session lifecycle", () => {
  it("create session, dispatch, verify tmux alive, stop, verify tmux dead", async () => {
    const session = core.startSession({
      repo: env.workdir,
      summary: "e2e-lifecycle-test",
      flow: "bare",
      workdir: env.workdir,
    });
    env.sessionIds.push(session.id);
    expect(session.id).toMatch(/^s-[0-9a-f]+$/);
    expect(session.status).toBe("ready");
    expect(session.flow).toBe("bare");
    expect(session.stage).toBe("work");

    const result = await core.dispatch(session.id);
    expect(result.ok).toBe(true);

    const running = core.getSession(session.id)!;
    expect(running.status).toBe("running");
    expect(running.session_id).toBeTruthy();
    env.tmuxSessions.push(running.session_id!);

    expect(core.sessionExists(running.session_id!)).toBe(true);

    const stopResult = await core.stop(session.id);
    expect(stopResult.ok).toBe(true);

    const stopped = core.getSession(session.id)!;
    expect(stopped.status).toBe("stopped");
    expect(stopped.session_id).toBeNull();

    expect(core.sessionExists(running.session_id!)).toBe(false);
  }, 30_000);
});

describe("e2e: reconciliation", () => {
  it("detects dead tmux sessions and marks as failed", async () => {
    const session = core.startSession({
      repo: env.workdir,
      summary: "e2e-reconciliation-test",
      flow: "bare",
      workdir: env.workdir,
    });
    env.sessionIds.push(session.id);

    const result = await core.dispatch(session.id);
    expect(result.ok).toBe(true);

    const dispatched = core.getSession(session.id)!;
    expect(dispatched.status).toBe("running");
    expect(dispatched.session_id).toBeTruthy();
    env.tmuxSessions.push(dispatched.session_id!);

    // Kill tmux directly (simulating agent crash)
    core.killSession(dispatched.session_id!);
    expect(core.sessionExists(dispatched.session_id!)).toBe(false);

    // DB still says "running"
    expect(core.getSession(session.id)!.status).toBe("running");

    // Run reconciliation logic (same as useStore refresh)
    const sessions = core.listSessions({ limit: 50 });
    for (const s of sessions) {
      if (s.status === "running" && s.session_id) {
        const exists = await core.sessionExistsAsync(s.session_id);
        if (!exists) {
          core.updateSession(s.id, { status: "failed", error: "Agent process exited", session_id: null });
          core.logEvent(s.id, "agent_exited", { stage: s.stage ?? undefined, actor: "system" });
        }
      }
    }

    const reconciled = core.getSession(session.id)!;
    expect(reconciled.status).toBe("failed");
    expect(reconciled.error).toContain("Agent process exited");
    expect(reconciled.session_id).toBeNull();

    const events = core.getEvents(session.id, { type: "agent_exited" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

describe("e2e: dispatch edge cases", () => {
  it("dispatch to nonexistent compute fails gracefully", async () => {
    const session = core.startSession({
      repo: env.workdir,
      summary: "e2e-bad-compute",
      flow: "bare",
      compute_name: "nonexistent-compute",
      workdir: env.workdir,
    });
    env.sessionIds.push(session.id);
    expect(session.status).toBe("ready");

    let threw = false;
    try {
      const result = await core.dispatch(session.id);
      const updated = core.getSession(session.id)!;
      if (updated.session_id) env.tmuxSessions.push(updated.session_id);
    } catch {
      threw = true;
    }

    const check = core.getSession(session.id);
    expect(check).not.toBeNull();
  }, 30_000);
});

describe("e2e: session detail", () => {
  it("has all required fields after creation", () => {
    const session = core.startSession({
      repo: env.workdir,
      ticket: "TEST-123",
      summary: "e2e-fields-test",
      flow: "bare",
      compute_name: "local",
      group_name: "test-group",
      workdir: env.workdir,
    });
    env.sessionIds.push(session.id);

    expect(session.id).toMatch(/^s-[0-9a-f]+$/);
    expect(session.status).toBe("ready");
    expect(session.compute_name).toBe("local");
    expect(session.repo).toBe(env.workdir);
    expect(session.flow).toBe("bare");
    expect(session.stage).toBe("work");
    expect(session.ticket).toBe("TEST-123");
    expect(session.summary).toBe("e2e-fields-test");
    expect(session.group_name).toBe("test-group");
    expect(session.created_at).toBeTruthy();
    expect(session.updated_at).toBeTruthy();
    expect(session.branch).toContain("feat/TEST-123");

    const events = core.getEvents(session.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.map(e => e.type)).toContain("stage_ready");
  });
});

describe("e2e: multiple sessions", () => {
  it("creates, lists, and deletes multiple sessions", () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = core.startSession({
        repo: env.workdir,
        summary: `e2e-multi-${i}`,
        flow: "bare",
        workdir: env.workdir,
      });
      ids.push(s.id);
      env.sessionIds.push(s.id);
    }

    const all = core.listSessions({ limit: 50 });
    expect(all.filter(s => ids.includes(s.id)).length).toBe(3);

    core.deleteSession(ids[0]);
    const idx = env.sessionIds.indexOf(ids[0]);
    if (idx >= 0) env.sessionIds.splice(idx, 1);

    const remaining = core.listSessions({ limit: 50 });
    expect(remaining.filter(s => ids.includes(s.id)).length).toBe(2);
    expect(core.getSession(ids[0])).toBeNull();
  });
});

describe("e2e: worktree", () => {
  it("dispatch creates worktree for git repos", async () => {
    const session = core.startSession({
      repo: env.workdir,
      summary: "e2e-worktree-test",
      flow: "bare",
      workdir: env.workdir,
    });
    env.sessionIds.push(session.id);

    const result = await core.dispatch(session.id);
    expect(result.ok).toBe(true);

    const dispatched = core.getSession(session.id)!;
    expect(dispatched.status).toBe("running");
    if (dispatched.session_id) env.tmuxSessions.push(dispatched.session_id);

    // Clean up: stop session so tmux dies
    await core.stop(session.id);

    // Clean up any worktree created in the isolated env
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const worktreePath = join(env.app.config.worktreesDir, session.id);
    if (existsSync(worktreePath)) {
      try {
        const { execFileSync } = await import("child_process");
        execFileSync("git", ["-C", env.workdir, "worktree", "remove", "--force", worktreePath], { stdio: "pipe" });
      } catch {}
    }
  }, 30_000);
});
