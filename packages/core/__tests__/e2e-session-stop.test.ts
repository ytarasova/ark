/**
 * E2E tests for session stop behavior — preserving claude_session_id.
 *
 * Validates that:
 * - stop() sets status to "stopped"
 * - stop() preserves claude_session_id (does NOT null it out)
 * - After stop + restart, the session can resume with the same claude_session_id
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

describe("session stop preserves claude_session_id", () => {
  it("stop() sets status to stopped", async () => {
    const session = createSession({ summary: "stop-status-test" });
    updateSession(session.id, { status: "running", stage: "work" });

    const result = await stop(session.id);
    expect(result.ok).toBe(true);

    const updated = getSession(session.id)!;
    expect(updated.status).toBe("stopped");
  });

  it("stop() preserves claude_session_id (does NOT null it out)", async () => {
    const session = createSession({ summary: "stop-preserve-id" });
    updateSession(session.id, {
      status: "running",
      stage: "work",
      claude_session_id: "claude-uuid-12345",
      session_id: "ark-s-test",
    });

    await stop(session.id);

    const updated = getSession(session.id)!;
    expect(updated.status).toBe("stopped");
    expect(updated.claude_session_id).toBe("claude-uuid-12345");
    // session_id (tmux name) should be cleared
    expect(updated.session_id).toBeNull();
  });

  it("after stop + updateSession to ready, claude_session_id is still intact", async () => {
    const claudeId = "uuid-for-resume-test";
    const session = createSession({ summary: "stop-resume-cycle" });
    updateSession(session.id, {
      status: "running",
      stage: "work",
      claude_session_id: claudeId,
      session_id: "ark-tmux-name",
    });

    // Stop the session
    await stop(session.id);
    const stopped = getSession(session.id)!;
    expect(stopped.status).toBe("stopped");
    expect(stopped.claude_session_id).toBe(claudeId);

    // Simulate resume preparation (what resume() does before dispatch)
    updateSession(session.id, {
      status: "ready",
      error: null,
      breakpoint_reason: null,
      attached_by: null,
      session_id: null,
    });

    // claude_session_id should still be preserved after the ready transition
    const ready = getSession(session.id)!;
    expect(ready.status).toBe("ready");
    expect(ready.claude_session_id).toBe(claudeId);
  });

  it("multiple stop cycles preserve the same claude_session_id", async () => {
    const claudeId = "persistent-uuid";
    const session = createSession({ summary: "multi-stop-test" });
    updateSession(session.id, {
      status: "running",
      stage: "work",
      claude_session_id: claudeId,
    });

    // First stop
    await stop(session.id);
    expect(getSession(session.id)!.claude_session_id).toBe(claudeId);

    // Simulate restart
    updateSession(session.id, { status: "running", session_id: "ark-tmux-2" });

    // Second stop
    await stop(session.id);
    expect(getSession(session.id)!.claude_session_id).toBe(claudeId);

    // Third cycle
    updateSession(session.id, { status: "running", session_id: "ark-tmux-3" });
    await stop(session.id);
    expect(getSession(session.id)!.claude_session_id).toBe(claudeId);
  });

  it("stop() nulls error field", async () => {
    const session = createSession({ summary: "stop-clears-error" });
    updateSession(session.id, {
      status: "running",
      stage: "work",
      error: "some transient error",
    });

    await stop(session.id);

    const updated = getSession(session.id)!;
    expect(updated.error).toBeNull();
  });

  it("stop() preserves stage and agent fields", async () => {
    const session = createSession({ summary: "stop-preserves-agent" });
    updateSession(session.id, {
      status: "running",
      stage: "review",
      agent: "reviewer",
      workdir: "/tmp/work",
    });

    await stop(session.id);

    const updated = getSession(session.id)!;
    expect(updated.stage).toBe("review");
    expect(updated.agent).toBe("reviewer");
    expect(updated.workdir).toBe("/tmp/work");
  });
});
