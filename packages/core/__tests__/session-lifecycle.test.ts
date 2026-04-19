/**
 * Tests for session-lifecycle.ts standalone functions:
 * forkSession, cloneSession, pause, restore, interrupt, approveReviewGate, waitForCompletion.
 *
 * Uses AppContext.forTest() for full integration with the DB layer.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import {
  forkSession,
  cloneSession,
  pause,
  restore,
  interrupt,
  approveReviewGate,
  waitForCompletion,
} from "../services/session-lifecycle.js";
import type { SessionStatus } from "../../types/index.js";

let app: AppContext;

beforeEach(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

// ── forkSession ──────────────────────────────────────────────────────────────

describe("forkSession", () => {
  it("creates a new session with same flow, stage, and group", () => {
    const original = app.sessions.create({ summary: "original", flow: "quick", repo: "/tmp/repo" });
    app.sessions.update(original.id, { stage: "plan", status: "running" as SessionStatus, group_name: "team-a" });

    const result = forkSession(app, original.id);
    expect(result.ok).toBe(true);

    const forked = app.sessions.get(result.sessionId!)!;
    expect(forked.id).not.toBe(original.id);
    expect(forked.flow).toBe("quick");
    expect(forked.stage).toBe("plan");
    expect(forked.status).toBe("ready");
    expect(forked.group_name).toBe("team-a");
    expect(forked.repo).toBe("/tmp/repo");
  });

  it("uses custom name when provided", () => {
    const original = app.sessions.create({ summary: "base" });
    const result = forkSession(app, original.id, "custom fork name");
    const forked = app.sessions.get(result.sessionId!)!;
    expect(forked.summary).toBe("custom fork name");
  });

  it("defaults fork name to '<summary> (fork)'", () => {
    const original = app.sessions.create({ summary: "my task" });
    const result = forkSession(app, original.id);
    const forked = app.sessions.get(result.sessionId!)!;
    expect(forked.summary).toBe("my task (fork)");
  });

  it("does NOT copy claude_session_id (shallow copy)", () => {
    const original = app.sessions.create({});
    app.sessions.update(original.id, { claude_session_id: "claude-abc" });
    const result = forkSession(app, original.id);
    const forked = app.sessions.get(result.sessionId!)!;
    expect(forked.claude_session_id).toBeNull();
  });

  it("logs session_forked event", () => {
    const original = app.sessions.create({});
    const result = forkSession(app, original.id);
    const evts = app.events.list(result.sessionId!, { type: "session_forked" });
    expect(evts.length).toBe(1);
    expect(evts[0].data?.forked_from).toBe(original.id);
  });

  it("returns error for nonexistent session", () => {
    const result = forkSession(app, "s-0000000000");
    expect(result.ok).toBe(false);
  });
});

// ── cloneSession ─────────────────────────────────────────────────────────────

describe("cloneSession", () => {
  it("copies claude_session_id for --resume (deep copy)", () => {
    const original = app.sessions.create({});
    app.sessions.update(original.id, {
      claude_session_id: "claude-xyz",
      stage: "code",
      status: "stopped" as SessionStatus,
      group_name: "grp",
    });

    const result = cloneSession(app, original.id);
    expect(result.ok).toBe(true);

    const cloned = app.sessions.get(result.sessionId!)!;
    expect(cloned.claude_session_id).toBe("claude-xyz");
    expect(cloned.stage).toBe("code");
    expect(cloned.status).toBe("ready");
    expect(cloned.group_name).toBe("grp");
  });

  it("uses custom name when provided", () => {
    const original = app.sessions.create({ summary: "base" });
    const result = cloneSession(app, original.id, "my clone");
    const cloned = app.sessions.get(result.sessionId!)!;
    expect(cloned.summary).toBe("my clone");
  });

  it("defaults clone name to '<summary> (clone)'", () => {
    const original = app.sessions.create({ summary: "task" });
    const result = cloneSession(app, original.id);
    const cloned = app.sessions.get(result.sessionId!)!;
    expect(cloned.summary).toBe("task (clone)");
  });

  it("logs session_cloned event with claude_session_id", () => {
    const original = app.sessions.create({});
    app.sessions.update(original.id, { claude_session_id: "c-123" });
    const result = cloneSession(app, original.id);
    const evts = app.events.list(result.sessionId!, { type: "session_cloned" });
    expect(evts.length).toBe(1);
    expect(evts[0].data?.cloned_from).toBe(original.id);
    expect(evts[0].data?.claude_session_id).toBe("c-123");
  });

  it("returns error for nonexistent session", () => {
    const result = cloneSession(app, "s-0000000000");
    expect(result.ok).toBe(false);
  });
});

// ── pause ────────────────────────────────────────────────────────────────────

describe("pause (lifecycle)", () => {
  it("transitions to blocked with reason", () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "running" as SessionStatus });
    const result = pause(app, s.id, "Needs review");
    expect(result.ok).toBe(true);

    const updated = app.sessions.get(s.id)!;
    expect(updated.status).toBe("blocked");
    expect(updated.breakpoint_reason).toBe("Needs review");
  });

  it("defaults reason to 'User paused'", () => {
    const s = app.sessions.create({});
    pause(app, s.id);
    expect(app.sessions.get(s.id)!.breakpoint_reason).toBe("User paused");
  });

  it("logs session_paused event with previous status", () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "running" as SessionStatus });
    pause(app, s.id, "test");
    const evts = app.events.list(s.id, { type: "session_paused" });
    expect(evts.length).toBe(1);
    expect(evts[0].data?.was_status).toBe("running");
  });

  it("returns error for nonexistent session", () => {
    const result = pause(app, "s-0000000000");
    expect(result.ok).toBe(false);
  });
});

// ── restore ──────────────────────────────────────────────────────────────────

describe("restore", () => {
  it("transitions archived -> stopped", () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "archived" as SessionStatus });
    const result = restore(app, s.id);
    expect(result.ok).toBe(true);
    expect(app.sessions.get(s.id)!.status).toBe("stopped");
  });

  it("logs session_restored event", () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "archived" as SessionStatus });
    restore(app, s.id);
    const evts = app.events.list(s.id, { type: "session_restored" });
    expect(evts.length).toBe(1);
  });

  it("fails if session is not archived", () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "running" as SessionStatus });
    const result = restore(app, s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("running");
  });

  it("returns error for nonexistent session", () => {
    const result = restore(app, "s-0000000000");
    expect(result.ok).toBe(false);
  });
});

// ── interrupt ────────────────────────────────────────────────────────────────

describe("interrupt", () => {
  it("fails if session is not running/waiting", async () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "stopped" as SessionStatus });
    const result = await interrupt(app, s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("stopped");
  });

  it("fails if no tmux session_id", async () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "running" as SessionStatus, session_id: null });
    const result = await interrupt(app, s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No tmux session");
  });

  it("returns error for nonexistent session", async () => {
    const result = await interrupt(app, "s-0000000000");
    expect(result.ok).toBe(false);
  });
});

// ── approveReviewGate ────────────────────────────────────────────────────────

describe("approveReviewGate", () => {
  it("logs review_approved event and calls advanceFn", async () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "blocked" as SessionStatus, stage: "review" });

    let advanceCalled = false;
    const mockAdvance = async (_app: AppContext, _id: string, force?: boolean) => {
      advanceCalled = true;
      expect(force).toBe(true);
      return { ok: true as const, message: "advanced" };
    };

    const result = await approveReviewGate(app, s.id, mockAdvance);
    expect(result.ok).toBe(true);
    expect(advanceCalled).toBe(true);

    const evts = app.events.list(s.id, { type: "review_approved" });
    expect(evts.length).toBe(1);
    expect(evts[0].actor).toBe("github");
  });

  it("returns error for nonexistent session", async () => {
    const result = await approveReviewGate(app, "s-0000000000", async () => ({
      ok: true,
      message: "ok",
    }));
    expect(result.ok).toBe(false);
  });
});

// ── waitForCompletion ────────────────────────────────────────────────────────

describe("waitForCompletion", () => {
  it("returns immediately for terminal state", async () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "completed" as SessionStatus });

    const { session, timedOut } = await waitForCompletion(app, s.id, { timeoutMs: 1000, pollMs: 50 });
    expect(timedOut).toBe(false);
    expect(session!.status).toBe("completed");
  });

  it("returns immediately for failed state", async () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "failed" as SessionStatus });

    const { session, timedOut } = await waitForCompletion(app, s.id, { timeoutMs: 1000, pollMs: 50 });
    expect(timedOut).toBe(false);
    expect(session!.status).toBe("failed");
  });

  it("returns immediately for stopped state", async () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "stopped" as SessionStatus });

    const { session, timedOut } = await waitForCompletion(app, s.id, { timeoutMs: 1000, pollMs: 50 });
    expect(timedOut).toBe(false);
    expect(session!.status).toBe("stopped");
  });

  it("times out for non-terminal state", async () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "running" as SessionStatus });

    const { session, timedOut } = await waitForCompletion(app, s.id, { timeoutMs: 150, pollMs: 50 });
    expect(timedOut).toBe(true);
    expect(session!.status).toBe("running");
  });

  it("returns null session for nonexistent id", async () => {
    const { session, timedOut } = await waitForCompletion(app, "s-0000000000", { timeoutMs: 100, pollMs: 50 });
    expect(session).toBeNull();
    expect(timedOut).toBe(false);
  });

  it("calls onStatus callback while polling", async () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "running" as SessionStatus });

    const statuses: string[] = [];
    const { timedOut } = await waitForCompletion(app, s.id, {
      timeoutMs: 200,
      pollMs: 50,
      onStatus: (status) => statuses.push(status),
    });
    expect(timedOut).toBe(true);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === "running")).toBe(true);
  });

  it("detects state transition during polling", async () => {
    const s = app.sessions.create({});
    app.sessions.update(s.id, { status: "running" as SessionStatus });

    // Transition to completed after a short delay
    setTimeout(() => {
      app.sessions.update(s.id, { status: "completed" as SessionStatus });
    }, 100);

    const { session, timedOut } = await waitForCompletion(app, s.id, { timeoutMs: 2000, pollMs: 50 });
    expect(timedOut).toBe(false);
    expect(session!.status).toBe("completed");
  });
});
