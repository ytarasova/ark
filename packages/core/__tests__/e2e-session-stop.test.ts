/**
 * E2E tests for session stop behavior -- preserving claude_session_id.
 *
 * Validates that:
 * - stop(app) sets status to "stopped"
 * - stop(app) preserves claude_session_id (does NOT null it out)
 * - After stop + restart, the session can resume with the same claude_session_id
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { stop } from "../services/session-orchestration.js";
import { AppContext } from "../app.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

describe("session stop preserves claude_session_id", async () => {
  it("stop(app) sets status to stopped", async () => {
    const session = await getApp().sessions.create({ summary: "stop-status-test" });
    await getApp().sessions.update(session.id, { status: "running", stage: "work" });

    const result = await stop(app, session.id);
    expect(result.ok).toBe(true);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
  });

  it("stop(app) preserves claude_session_id (does NOT null it out)", async () => {
    const session = await getApp().sessions.create({ summary: "stop-preserve-id" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "work",
      claude_session_id: "claude-uuid-12345",
      session_id: "ark-s-test",
    });

    await stop(app, session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
    expect(updated.claude_session_id).toBe("claude-uuid-12345");
    // session_id (tmux name) should be cleared
    expect(updated.session_id).toBeNull();
  });

  it("after stop + updateSession to ready, claude_session_id is still intact", async () => {
    const claudeId = "uuid-for-resume-test";
    const session = await getApp().sessions.create({ summary: "stop-resume-cycle" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "work",
      claude_session_id: claudeId,
      session_id: "ark-tmux-name",
    });

    // Stop the session
    await stop(app, session.id);
    const stopped = (await getApp().sessions.get(session.id))!;
    expect(stopped.status).toBe("stopped");
    expect(stopped.claude_session_id).toBe(claudeId);

    // Simulate resume preparation (what resume(app) does before dispatch)
    await getApp().sessions.update(session.id, {
      status: "ready",
      error: null,
      breakpoint_reason: null,
      attached_by: null,
      session_id: null,
    });

    // claude_session_id should still be preserved after the ready transition
    const ready = (await getApp().sessions.get(session.id))!;
    expect(ready.status).toBe("ready");
    expect(ready.claude_session_id).toBe(claudeId);
  });

  it("multiple stop cycles preserve the same claude_session_id", async () => {
    const claudeId = "persistent-uuid";
    const session = await getApp().sessions.create({ summary: "multi-stop-test" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "work",
      claude_session_id: claudeId,
    });

    // First stop
    await stop(app, session.id);
    expect((await getApp().sessions.get(session.id))!.claude_session_id).toBe(claudeId);

    // Simulate restart
    await getApp().sessions.update(session.id, { status: "running", session_id: "ark-tmux-2" });

    // Second stop
    await stop(app, session.id);
    expect((await getApp().sessions.get(session.id))!.claude_session_id).toBe(claudeId);

    // Third cycle
    await getApp().sessions.update(session.id, { status: "running", session_id: "ark-tmux-3" });
    await stop(app, session.id);
    expect((await getApp().sessions.get(session.id))!.claude_session_id).toBe(claudeId);
  });

  it("stop(app) nulls error field", async () => {
    const session = await getApp().sessions.create({ summary: "stop-clears-error" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "work",
      error: "some transient error",
    });

    await stop(app, session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.error).toBeNull();
  });

  it("stop(app) preserves stage and agent fields", async () => {
    const session = await getApp().sessions.create({ summary: "stop-preserves-agent" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "review",
      agent: "reviewer",
      workdir: "/tmp/work",
    });

    await stop(app, session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.stage).toBe("review");
    expect(updated.agent).toBe("reviewer");
    expect(updated.workdir).toBe("/tmp/work");
  });
});
