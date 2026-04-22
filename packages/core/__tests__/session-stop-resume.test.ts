/**
 * Tests for session stop/resume lifecycle.
 * Verifies that stop(app) sets correct status/fields and resume(app) re-dispatches.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

describe("session stop", async () => {
  it("sets status to 'stopped' (not 'failed')", async () => {
    const session = await getApp().sessions.create({ summary: "stop-test" });
    await getApp().sessions.update(session.id, { status: "running", stage: "work" });

    const result = await app.sessionLifecycle.stop(session.id);
    expect(result.ok).toBe(true);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
    expect(updated.status).not.toBe("failed");
  });

  it("preserves claude_session_id for resume", async () => {
    const session = await getApp().sessions.create({ summary: "stop-claude" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "work",
      claude_session_id: "uuid-to-preserve",
    });

    await app.sessionLifecycle.stop(session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.claude_session_id).toBe("uuid-to-preserve");
  });

  it("clears session_id (tmux name)", async () => {
    const session = await getApp().sessions.create({ summary: "stop-session-id" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-s-abc123",
    });

    await app.sessionLifecycle.stop(session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.session_id).toBeNull();
  });

  it("sets error to null", async () => {
    const session = await getApp().sessions.create({ summary: "stop-error-clear" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "work",
      error: "some previous error",
    });

    await app.sessionLifecycle.stop(session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.error).toBeNull();
  });

  it("returns ok: true with message", async () => {
    const session = await getApp().sessions.create({ summary: "stop-msg" });
    await getApp().sessions.update(session.id, { status: "running", stage: "work" });

    const result = await app.sessionLifecycle.stop(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Session stopped");
  });

  it("returns ok: false for nonexistent session", async () => {
    const result = await app.sessionLifecycle.stop("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("can stop a session in 'ready' status", async () => {
    const session = await getApp().sessions.create({ summary: "stop-ready" });
    await getApp().sessions.update(session.id, { status: "ready", stage: "work" });

    const result = await app.sessionLifecycle.stop(session.id);
    expect(result.ok).toBe(true);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
  });

  it("can stop a session in 'blocked' status", async () => {
    const session = await getApp().sessions.create({ summary: "stop-blocked" });
    await getApp().sessions.update(session.id, { status: "blocked", stage: "work" });

    const result = await app.sessionLifecycle.stop(session.id);
    expect(result.ok).toBe(true);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
  });

  it("preserves other session fields after stop", async () => {
    const session = await getApp().sessions.create({ summary: "preserve-fields", repo: "/my/repo" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "work",
      agent: "coder",
      workdir: "/tmp/worktree",
    });

    await app.sessionLifecycle.stop(session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.summary).toBe("preserve-fields");
    expect(updated.repo).toBe("/my/repo");
    expect(updated.agent).toBe("coder");
    expect(updated.workdir).toBe("/tmp/worktree");
    expect(updated.stage).toBe("work");
  });

  it("clears runtime fields but preserves claude_session_id", async () => {
    const session = await getApp().sessions.create({ summary: "clear-all" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-tmux",
      claude_session_id: "claude-uuid",
      error: "old error",
    });

    await app.sessionLifecycle.stop(session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
    expect(updated.session_id).toBeNull();
    expect(updated.claude_session_id).toBe("claude-uuid");
    expect(updated.error).toBeNull();
  });
});

describe("session resume", async () => {
  // Note: resume(app) calls dispatch(app) which requires tmux and claude CLI,
  // so we test the status changes and guard clauses rather than full dispatch.

  it("resume(app) is exported as a function", async () => {
    const { resume } = await import("../services/dispatch.js");
    expect(typeof resume).toBe("function");
  });

  it("resume returns ok: false for nonexistent session", async () => {
    const { resume } = await import("../services/dispatch.js");
    const result = await resume(app, "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("resume allows completed sessions to restart", async () => {
    const { resume } = await import("../services/dispatch.js");
    const session = await getApp().sessions.create({ summary: "completed-test" });
    await getApp().sessions.update(session.id, { status: "completed", stage: "work" });

    const result = await resume(app, session.id);
    // Completed sessions can now be resumed (dispatches again)
    // It may fail for other reasons (no flow stage) but not because of "completed" status
    expect(result.message).not.toContain("completed");
  });

  it("stopped session can transition to ready via updateSession", async () => {
    const session = await getApp().sessions.create({ summary: "resume-ready" });
    await getApp().sessions.update(session.id, { status: "running", stage: "work" });
    await app.sessionLifecycle.stop(session.id);

    // Simulate what resume does (without dispatch)
    await getApp().sessions.update(session.id, {
      status: "ready",
      error: null,
      breakpoint_reason: null,
      attached_by: null,
      session_id: null,
    });

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("ready");
    expect(updated.error).toBeNull();
    expect(updated.breakpoint_reason).toBeNull();
  });

  it("stop then ready transition preserves stage", async () => {
    const session = await getApp().sessions.create({ summary: "stage-preserve" });
    await getApp().sessions.update(session.id, { status: "running", stage: "deploy" });
    await app.sessionLifecycle.stop(session.id);

    await getApp().sessions.update(session.id, { status: "ready" });

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.stage).toBe("deploy");
  });
});
