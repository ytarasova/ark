/**
 * Tests for session stop/resume lifecycle.
 * Verifies that stop() sets correct status/fields and resume() re-dispatches.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { getSession, updateSession } from "../index.js";
import { createSession } from "../store.js";
import { stop } from "../session.js";
import { AppContext, setApp, clearApp } from "../app.js";

let app: AppContext;

beforeEach(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

describe("session stop", () => {
  it("sets status to 'stopped' (not 'failed')", async () => {
    const session = createSession({ summary: "stop-test" });
    updateSession(session.id, { status: "running", stage: "work" });

    const result = await stop(session.id);
    expect(result.ok).toBe(true);

    const updated = getSession(session.id)!;
    expect(updated.status).toBe("stopped");
    expect(updated.status).not.toBe("failed");
  });

  it("clears claude_session_id", async () => {
    const session = createSession({ summary: "stop-claude" });
    updateSession(session.id, {
      status: "running",
      stage: "work",
      claude_session_id: "uuid-to-clear",
    });

    await stop(session.id);

    const updated = getSession(session.id)!;
    expect(updated.claude_session_id).toBeNull();
  });

  it("clears session_id (tmux name)", async () => {
    const session = createSession({ summary: "stop-session-id" });
    updateSession(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-s-abc123",
    });

    await stop(session.id);

    const updated = getSession(session.id)!;
    expect(updated.session_id).toBeNull();
  });

  it("sets error to null", async () => {
    const session = createSession({ summary: "stop-error-clear" });
    updateSession(session.id, {
      status: "running",
      stage: "work",
      error: "some previous error",
    });

    await stop(session.id);

    const updated = getSession(session.id)!;
    expect(updated.error).toBeNull();
  });

  it("returns ok: true with message", async () => {
    const session = createSession({ summary: "stop-msg" });
    updateSession(session.id, { status: "running", stage: "work" });

    const result = await stop(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Session stopped");
  });

  it("returns ok: false for nonexistent session", async () => {
    const result = await stop("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("can stop a session in 'ready' status", async () => {
    const session = createSession({ summary: "stop-ready" });
    updateSession(session.id, { status: "ready", stage: "work" });

    const result = await stop(session.id);
    expect(result.ok).toBe(true);

    const updated = getSession(session.id)!;
    expect(updated.status).toBe("stopped");
  });

  it("can stop a session in 'blocked' status", async () => {
    const session = createSession({ summary: "stop-blocked" });
    updateSession(session.id, { status: "blocked", stage: "work" });

    const result = await stop(session.id);
    expect(result.ok).toBe(true);

    const updated = getSession(session.id)!;
    expect(updated.status).toBe("stopped");
  });

  it("preserves other session fields after stop", async () => {
    const session = createSession({ summary: "preserve-fields", repo: "/my/repo" });
    updateSession(session.id, {
      status: "running",
      stage: "work",
      agent: "coder",
      workdir: "/tmp/worktree",
    });

    await stop(session.id);

    const updated = getSession(session.id)!;
    expect(updated.summary).toBe("preserve-fields");
    expect(updated.repo).toBe("/my/repo");
    expect(updated.agent).toBe("coder");
    expect(updated.workdir).toBe("/tmp/worktree");
    expect(updated.stage).toBe("work");
  });

  it("clears all runtime fields at once", async () => {
    const session = createSession({ summary: "clear-all" });
    updateSession(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-tmux",
      claude_session_id: "claude-uuid",
      error: "old error",
    });

    await stop(session.id);

    const updated = getSession(session.id)!;
    expect(updated.status).toBe("stopped");
    expect(updated.session_id).toBeNull();
    expect(updated.claude_session_id).toBeNull();
    expect(updated.error).toBeNull();
  });
});

describe("session resume", () => {
  // Note: resume() calls dispatch() which requires tmux and claude CLI,
  // so we test the status changes and guard clauses rather than full dispatch.

  it("resume() is exported as a function", async () => {
    const { resume } = await import("../session.js");
    expect(typeof resume).toBe("function");
  });

  it("resume returns ok: false for nonexistent session", async () => {
    const { resume } = await import("../session.js");
    const result = await resume("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("resume returns ok: false for completed session", async () => {
    const { resume } = await import("../session.js");
    const session = createSession({ summary: "completed-test" });
    updateSession(session.id, { status: "completed", stage: "work" });

    const result = await resume(session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("completed");
  });

  it("stopped session can transition to ready via updateSession", async () => {
    const session = createSession({ summary: "resume-ready" });
    updateSession(session.id, { status: "running", stage: "work" });
    await stop(session.id);

    // Simulate what resume does (without dispatch)
    updateSession(session.id, {
      status: "ready",
      error: null,
      breakpoint_reason: null,
      attached_by: null,
      session_id: null,
    });

    const updated = getSession(session.id)!;
    expect(updated.status).toBe("ready");
    expect(updated.error).toBeNull();
    expect(updated.breakpoint_reason).toBeNull();
  });

  it("stop then ready transition preserves stage", async () => {
    const session = createSession({ summary: "stage-preserve" });
    updateSession(session.id, { status: "running", stage: "deploy" });
    await stop(session.id);

    updateSession(session.id, { status: "ready" });

    const updated = getSession(session.id)!;
    expect(updated.stage).toBe("deploy");
  });
});
