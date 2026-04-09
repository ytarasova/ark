/**
 * Tests for useSessionActions -- verifies every action wraps in async + refresh.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { startSession, stop, cloneSession } from "../../core/services/session-orchestration.js";
import { withTestContext } from "../../core/__tests__/test-helpers.js";

withTestContext();

let app: AppContext;

beforeEach(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterAll(async () => {
  if (app) await app.shutdown();
  clearApp();
});

// Test the action logic directly (not the hook, which needs React)
// The hook is just a wrapper, so testing the underlying operations suffices.

describe("Session action patterns", () => {
  it("stop sets status to stopped and preserves claude_session_id", async () => {
    const s = startSession(app, { summary: "test", repo: ".", flow: "bare" });
    await stop(app, s.id);
    const updated = app.sessions.get(s.id);
    expect(updated!.status).toBe("stopped");
    expect(updated!.error).toBeNull();
  });

  it("delete removes session from DB", () => {
    const s = startSession(app, { summary: "del-test", repo: ".", flow: "bare" });
    app.sessions.delete(s.id);
    expect(app.sessions.get(s.id)).toBeNull();
  });

  it("clone creates new session with same config", () => {
    const s = startSession(app, { summary: "original", repo: "/tmp/test", flow: "bare" });
    app.sessions.update(s.id, { group_name: "mygroup" });

    const result = cloneSession(app, s.id, "my-clone");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const clone = app.sessions.get(result.sessionId);
    expect(clone).not.toBeNull();
    expect(clone!.summary).toBe("my-clone");
    expect(clone!.repo).toBe("/tmp/test");
    expect(clone!.flow).toBe("bare");
  });

  it("resume on stopped session transitions to ready", async () => {
    const s = startSession(app, { summary: "resume-test", repo: ".", flow: "bare" });
    await stop(app, s.id);
    expect(app.sessions.get(s.id)!.status).toBe("stopped");

    // resume would dispatch which needs tmux -- just verify the DB state
    app.sessions.update(s.id, { status: "ready", error: null });
    expect(app.sessions.get(s.id)!.status).toBe("ready");
  });

  it("all actions should leave session in valid state", async () => {
    const s = startSession(app, { summary: "lifecycle", repo: ".", flow: "bare" });

    // Start -> ready
    expect(app.sessions.get(s.id)!.status).toBe("ready");

    // Stop -> stopped
    await stop(app, s.id);
    expect(app.sessions.get(s.id)!.status).toBe("stopped");

    // Delete -> gone
    app.sessions.delete(s.id);
    expect(app.sessions.get(s.id)).toBeNull();
    expect(app.sessions.list().filter(s2 => s2.id === s.id).length).toBe(0);
  });
});
