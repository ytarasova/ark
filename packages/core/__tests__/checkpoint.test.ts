/**
 * Tests for checkpoint system: save, load, orphan detection, recovery.
 */

import { describe, it, expect, mock } from "bun:test";
import {
  saveCheckpoint,
  getCheckpoint,
  listCheckpoints,
  findOrphanedSessions,
  recoverSession,
} from "../session/checkpoint.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("saveCheckpoint", () => {
  it("stores a checkpoint event with full state", async () => {
    const session = await getApp().sessions.create({ summary: "test checkpoint", repo: "/tmp/repo" });
    await getApp().sessions.update(session.id, {
      stage: "implement",
      status: "running",
      claude_session_id: "claude-abc",
      session_id: "ark-s-123",
      workdir: "/tmp/work",
      compute_name: "local",
      agent: "implementer",
    });

    await saveCheckpoint(getApp(), session.id);

    const events = await getApp().events.list(session.id, { type: "checkpoint" });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("checkpoint");
    expect(events[0].stage).toBe("implement");
    expect(events[0].actor).toBe("system");

    const data = events[0].data!;
    expect(data.stage).toBe("implement");
    expect(data.status).toBe("running");
    expect(data.claudeSessionId).toBe("claude-abc");
    expect(data.tmuxSessionId).toBe("ark-s-123");
    expect(data.workdir).toBe("/tmp/work");
    expect(data.computeName).toBe("local");
    expect(data.agent).toBe("implementer");
  });

  it("does nothing for nonexistent session", async () => {
    // Should not throw
    await saveCheckpoint(getApp(), "s-nonexistent");
  });
});

describe("getCheckpoint", () => {
  it("returns latest checkpoint", async () => {
    const session = await getApp().sessions.create({ summary: "multi checkpoint" });
    await getApp().sessions.update(session.id, { session_id: `ark-s-${session.id}`, stage: "plan", status: "running" });
    await saveCheckpoint(getApp(), session.id);

    await getApp().sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      stage: "implement",
      status: "running",
    });
    await saveCheckpoint(getApp(), session.id);

    const cp = await getCheckpoint(getApp(), session.id);
    expect(cp).not.toBeNull();
    expect(cp!.stage).toBe("implement");
    expect(cp!.sessionId).toBe(session.id);
  });

  it("returns null when no checkpoints exist", async () => {
    const session = await getApp().sessions.create({ summary: "no checkpoints" });
    expect(await getCheckpoint(getApp(), session.id)).toBeNull();
  });
});

describe("listCheckpoints", () => {
  it("returns all checkpoints in order", async () => {
    const session = await getApp().sessions.create({ summary: "list test" });

    await getApp().sessions.update(session.id, { session_id: `ark-s-${session.id}`, stage: "plan", status: "running" });
    await saveCheckpoint(getApp(), session.id);

    await getApp().sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      stage: "implement",
      status: "running",
    });
    await saveCheckpoint(getApp(), session.id);

    await getApp().sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      stage: "review",
      status: "running",
    });
    await saveCheckpoint(getApp(), session.id);

    const checkpoints = await listCheckpoints(getApp(), session.id);
    expect(checkpoints.length).toBe(3);
    expect(checkpoints[0].stage).toBe("plan");
    expect(checkpoints[1].stage).toBe("implement");
    expect(checkpoints[2].stage).toBe("review");
  });

  it("returns empty array when no checkpoints", async () => {
    const session = await getApp().sessions.create({ summary: "empty" });
    expect(await listCheckpoints(getApp(), session.id)).toEqual([]);
  });
});

describe("findOrphanedSessions", () => {
  it("finds running sessions whose tmux session no longer exists", async () => {
    // The running-invariant (session.ts update()) prevents constructing a
    // running session with session_id=null directly -- that's the whole
    // point of the fix. To simulate an orphan we point session_id at a
    // tmux session that doesn't exist, which is the other arm of
    // findOrphanedSessions's filter.
    const session = await getApp().sessions.create({ summary: "orphan no tmux" });
    await getApp().sessions.update(session.id, {
      status: "running",
      session_id: "ark-s-nonexistent-tmux-handle",
    });

    const orphaned = await findOrphanedSessions(getApp());
    expect(orphaned.some((s) => s.id === session.id)).toBe(true);
  });

  it("does not include stopped or pending sessions", async () => {
    const stopped = await getApp().sessions.create({ summary: "stopped" });
    await getApp().sessions.update(stopped.id, { status: "stopped" });

    const pending = await getApp().sessions.create({ summary: "pending" });
    // pending is default status

    const orphaned = await findOrphanedSessions(getApp());
    expect(orphaned.some((s) => s.id === stopped.id)).toBe(false);
    expect(orphaned.some((s) => s.id === pending.id)).toBe(false);
  });

  it("finds running sessions where tmux session is dead", async () => {
    const session = await getApp().sessions.create({ summary: "dead tmux" });
    // Use a tmux name that definitely doesn't exist
    await getApp().sessions.update(session.id, { status: "running", session_id: "ark-nonexistent-test-session-xyz" });

    const orphaned = await findOrphanedSessions(getApp());
    expect(orphaned.some((s) => s.id === session.id)).toBe(true);
  });
});

describe("recoverSession", () => {
  it("resets session to ready with checkpoint data", async () => {
    const session = await getApp().sessions.create({ summary: "recover me" });
    await getApp().sessions.update(session.id, {
      stage: "implement",
      status: "running",
      claude_session_id: "claude-xyz",
      session_id: "ark-dead-session",
    });

    await saveCheckpoint(getApp(), session.id);

    // Simulate crash: session still says "running" but tmux is dead
    const result = await recoverSession(getApp(), session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Recovered from checkpoint");

    const recovered = (await getApp().sessions.get(session.id))!;
    expect(recovered.status).toBe("ready");
    expect(recovered.session_id).toBeNull(); // dead tmux cleared
    expect(recovered.claude_session_id).toBe("claude-xyz"); // preserved for --resume
    expect(recovered.stage).toBe("implement"); // restored from checkpoint

    // Verify recovery event logged
    const events = await getApp().events.list(session.id, { type: "session_recovered" });
    expect(events.length).toBe(1);
    expect(events[0].data!.from_status).toBe("running");
    expect(events[0].data!.had_checkpoint).toBe(true);
  });

  it("recovers without checkpoint (uses current session state)", async () => {
    const session = await getApp().sessions.create({ summary: "no checkpoint recovery" });
    await getApp().sessions.update(session.id, {
      stage: "plan",
      status: "running",
      session_id: "ark-dead",
    });

    // No checkpoint saved -- recover from current state
    const result = await recoverSession(getApp(), session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("no checkpoint");

    const recovered = (await getApp().sessions.get(session.id))!;
    expect(recovered.status).toBe("ready");
    expect(recovered.session_id).toBeNull();
  });

  it("returns error for nonexistent session", async () => {
    const result = await recoverSession(getApp(), "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("preserves claude_session_id from session when no checkpoint", async () => {
    const session = await getApp().sessions.create({ summary: "preserve claude id" });
    await getApp().sessions.update(session.id, {
      stage: "work",
      status: "running",
      claude_session_id: "claude-from-session",
      session_id: "ark-dead",
    });

    const result = await recoverSession(getApp(), session.id);
    expect(result.ok).toBe(true);

    const recovered = (await getApp().sessions.get(session.id))!;
    expect(recovered.claude_session_id).toBe("claude-from-session");
  });
});
