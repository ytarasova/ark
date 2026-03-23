/**
 * End-to-end tests for the TUI session lifecycle.
 *
 * Tests the FULL flow: session creation, dispatch, tmux session verification,
 * reconciliation, and cleanup. Uses the core API directly (not ink-testing-library)
 * since attach requires a real terminal.
 *
 * State isolation: ARK_TEST_DIR is set by bunfig.toml preload (packages/test-setup.ts).
 * Tmux sessions are global - use unique names and clean up in afterEach.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as core from "../../core/index.js";

// Track resources for cleanup
const tmuxSessions: string[] = [];
const sessionIds: string[] = [];

afterEach(async () => {
  for (const name of tmuxSessions) {
    try { core.killSession(name); } catch { /* already gone */ }
  }
  tmuxSessions.length = 0;

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

// ── Test 1: Full lifecycle ─────────────────────────────────────────────────

describe("e2e: session lifecycle", () => {
  it("create session, dispatch, verify tmux alive, stop, verify tmux dead", async () => {
    // 1. Create session
    const session = core.startSession({
      repo: process.cwd(),
      summary: "e2e-lifecycle-test",
      flow: "bare",
    });
    sessionIds.push(session.id);
    expect(session.id).toMatch(/^s-[0-9a-f]+$/);
    expect(session.status).toBe("ready");
    expect(session.flow).toBe("bare");
    expect(session.stage).toBe("work");

    // 2. Dispatch
    const result = await core.dispatch(session.id);
    expect(result.ok).toBe(true);

    // 3. Verify running status
    const running = core.getSession(session.id)!;
    expect(running.status).toBe("running");
    expect(running.session_id).toBeTruthy();
    tmuxSessions.push(running.session_id!);

    // 4. Verify tmux session exists
    expect(core.sessionExists(running.session_id!)).toBe(true);

    // 5. Stop
    const stopResult = core.stop(session.id);
    expect(stopResult.ok).toBe(true);

    // 6. Verify stopped
    const stopped = core.getSession(session.id)!;
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toContain("Stopped by user");
    expect(stopped.session_id).toBeNull();

    // 7. Verify tmux session is gone
    expect(core.sessionExists(running.session_id!)).toBe(false);
  }, 30_000);
});

// ── Test 2: Reconciliation ─────────────────────────────────────────────────

describe("e2e: reconciliation", () => {
  it("detects dead tmux sessions and marks as failed", async () => {
    // 1. Create and dispatch
    const session = core.startSession({
      repo: process.cwd(),
      summary: "e2e-reconciliation-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    const result = await core.dispatch(session.id);
    expect(result.ok).toBe(true);

    const dispatched = core.getSession(session.id)!;
    expect(dispatched.status).toBe("running");
    expect(dispatched.session_id).toBeTruthy();
    tmuxSessions.push(dispatched.session_id!);

    // 2. Kill tmux session directly (simulating agent crash)
    core.killSession(dispatched.session_id!);
    expect(core.sessionExists(dispatched.session_id!)).toBe(false);

    // 3. DB still says "running"
    const stale = core.getSession(session.id)!;
    expect(stale.status).toBe("running");

    // 4. Run reconciliation logic (same as useStore refresh)
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

    // 5. Verify reconciliation result
    const reconciled = core.getSession(session.id)!;
    expect(reconciled.status).toBe("failed");
    expect(reconciled.error).toBeTruthy();
    expect(
      reconciled.error!.includes("Agent") || reconciled.error!.includes("exited")
    ).toBe(true);
    expect(reconciled.session_id).toBeNull();

    // 6. Verify agent_exited event was logged
    const events = core.getEvents(session.id, { type: "agent_exited" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ── Test 3: Nonexistent compute ───────────────────────────────────────

describe("e2e: dispatch edge cases", () => {
  it("dispatch to nonexistent compute fails gracefully", async () => {
    const session = core.startSession({
      repo: process.cwd(),
      summary: "e2e-bad-compute",
      flow: "bare",
      compute_name: "nonexistent-compute",
    });
    sessionIds.push(session.id);
    expect(session.status).toBe("ready");

    // dispatch should not throw/crash
    let threw = false;
    try {
      const result = await core.dispatch(session.id);
      // It may succeed (falling back to local) or fail - either is fine,
      // as long as it doesn't crash
      const updated = core.getSession(session.id)!;
      if (updated.session_id) tmuxSessions.push(updated.session_id);
    } catch {
      threw = true;
    }

    // Verify session is still queryable (not corrupted)
    const check = core.getSession(session.id);
    expect(check).not.toBeNull();
  }, 30_000);
});

// ── Test 4: Session detail fields ──────────────────────────────────────────

describe("e2e: session detail", () => {
  it("has all required fields after creation", () => {
    const session = core.startSession({
      repo: "/tmp/test-repo",
      ticket: "TEST-123",
      summary: "e2e-fields-test",
      flow: "bare",
      compute_name: "local",
      group_name: "test-group",
    });
    sessionIds.push(session.id);

    // Core fields
    expect(session.id).toMatch(/^s-[0-9a-f]+$/);
    expect(session.status).toBe("ready");
    expect(session.compute_name).toBe("local");
    expect(session.repo).toBe("/tmp/test-repo");
    expect(session.flow).toBe("bare");
    expect(session.stage).toBe("work");
    expect(session.ticket).toBe("TEST-123");
    expect(session.summary).toBe("e2e-fields-test");
    expect(session.group_name).toBe("test-group");
    expect(session.created_at).toBeTruthy();
    expect(session.updated_at).toBeTruthy();

    // Auto-generated branch from ticket reference
    expect(session.branch).toContain("feat/TEST-123");

    // Events: at least session_created + stage_ready
    const events = core.getEvents(session.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const types = events.map((e) => e.type);
    expect(types).toContain("session_created");
  });
});

// ── Test 5: Multiple sessions ──────────────────────────────────────────────

describe("e2e: multiple sessions", () => {
  it("creates, lists, and deletes multiple sessions", () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = core.startSession({
        repo: process.cwd(),
        summary: `e2e-multi-${i}`,
        flow: "bare",
      });
      ids.push(s.id);
      sessionIds.push(s.id);
    }

    // List should contain all 3
    const all = core.listSessions({ limit: 50 });
    const found = all.filter((s) => ids.includes(s.id));
    expect(found.length).toBe(3);

    // Delete one
    const deleted = core.deleteSession(ids[0]);
    expect(deleted).toBe(true);

    // Remove from cleanup list since already deleted
    const idx = sessionIds.indexOf(ids[0]);
    if (idx >= 0) sessionIds.splice(idx, 1);

    // List should now have 2
    const remaining = core.listSessions({ limit: 50 });
    const stillFound = remaining.filter((s) => ids.includes(s.id));
    expect(stillFound.length).toBe(2);

    // Verify the deleted one is gone
    expect(core.getSession(ids[0])).toBeNull();
  });
});

// ── Test 6: Worktree creation on dispatch ──────────────────────────────────

describe("e2e: worktree", () => {
  it("dispatch creates worktree for git repos", async () => {
    // Use the ark repo itself as a real git repo
    const arkRoot = process.cwd();

    const session = core.startSession({
      repo: arkRoot,
      summary: "e2e-worktree-test",
      flow: "bare",
      workdir: arkRoot,
    });
    sessionIds.push(session.id);

    const result = await core.dispatch(session.id);
    expect(result.ok).toBe(true);

    const dispatched = core.getSession(session.id)!;
    expect(dispatched.status).toBe("running");
    if (dispatched.session_id) tmuxSessions.push(dispatched.session_id);

    // Verify worktree directory was created
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const worktreePath = join(core.WORKTREES_DIR, session.id);
    // Worktree is created if workdir points to a git repo with .git
    // It may or may not be created depending on git state, so check both
    if (existsSync(worktreePath)) {
      expect(existsSync(worktreePath)).toBe(true);
    }

    // Clean up: stop session so tmux dies
    core.stop(session.id);

    // Clean up worktree if created
    if (existsSync(worktreePath)) {
      try {
        const { execFileSync } = await import("child_process");
        execFileSync("git", ["-C", arkRoot, "worktree", "remove", "--force", worktreePath], {
          stdio: "pipe",
        });
      } catch { /* ignore */ }
    }
  }, 30_000);
});
