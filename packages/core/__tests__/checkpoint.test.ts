/**
 * Tests for checkpoint system: save, load, orphan detection, recovery.
 */

import { describe, it, expect, mock } from "bun:test";
import { createSession, getSession, updateSession, getEvents, logEvent } from "../store.js";
import { saveCheckpoint, getCheckpoint, listCheckpoints, findOrphanedSessions, recoverSession } from "../checkpoint.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("saveCheckpoint", () => {
  it("stores a checkpoint event with full state", () => {
    const session = createSession({ summary: "test checkpoint", repo: "/tmp/repo" });
    updateSession(session.id, {
      stage: "implement",
      status: "running",
      claude_session_id: "claude-abc",
      session_id: "ark-s-123",
      workdir: "/tmp/work",
      compute_name: "local",
      agent: "implementer",
    });

    saveCheckpoint(session.id);

    const events = getEvents(session.id, { type: "checkpoint" });
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

  it("does nothing for nonexistent session", () => {
    // Should not throw
    saveCheckpoint("s-nonexistent");
  });
});

describe("getCheckpoint", () => {
  it("returns latest checkpoint", () => {
    const session = createSession({ summary: "multi checkpoint" });
    updateSession(session.id, { stage: "plan", status: "running" });
    saveCheckpoint(session.id);

    updateSession(session.id, { stage: "implement", status: "running" });
    saveCheckpoint(session.id);

    const cp = getCheckpoint(session.id);
    expect(cp).not.toBeNull();
    expect(cp!.stage).toBe("implement");
    expect(cp!.sessionId).toBe(session.id);
  });

  it("returns null when no checkpoints exist", () => {
    const session = createSession({ summary: "no checkpoints" });
    expect(getCheckpoint(session.id)).toBeNull();
  });
});

describe("listCheckpoints", () => {
  it("returns all checkpoints in order", () => {
    const session = createSession({ summary: "list test" });

    updateSession(session.id, { stage: "plan", status: "running" });
    saveCheckpoint(session.id);

    updateSession(session.id, { stage: "implement", status: "running" });
    saveCheckpoint(session.id);

    updateSession(session.id, { stage: "review", status: "running" });
    saveCheckpoint(session.id);

    const checkpoints = listCheckpoints(session.id);
    expect(checkpoints.length).toBe(3);
    expect(checkpoints[0].stage).toBe("plan");
    expect(checkpoints[1].stage).toBe("implement");
    expect(checkpoints[2].stage).toBe("review");
  });

  it("returns empty array when no checkpoints", () => {
    const session = createSession({ summary: "empty" });
    expect(listCheckpoints(session.id)).toEqual([]);
  });
});

describe("findOrphanedSessions", () => {
  it("finds running sessions with no tmux session_id", () => {
    const session = createSession({ summary: "orphan no tmux" });
    updateSession(session.id, { status: "running", session_id: null });

    const orphaned = findOrphanedSessions();
    expect(orphaned.some((s) => s.id === session.id)).toBe(true);
  });

  it("does not include stopped or pending sessions", () => {
    const stopped = createSession({ summary: "stopped" });
    updateSession(stopped.id, { status: "stopped" });

    const pending = createSession({ summary: "pending" });
    // pending is default status

    const orphaned = findOrphanedSessions();
    expect(orphaned.some((s) => s.id === stopped.id)).toBe(false);
    expect(orphaned.some((s) => s.id === pending.id)).toBe(false);
  });

  it("finds running sessions where tmux session is dead", () => {
    const session = createSession({ summary: "dead tmux" });
    // Use a tmux name that definitely doesn't exist
    updateSession(session.id, { status: "running", session_id: "ark-nonexistent-test-session-xyz" });

    const orphaned = findOrphanedSessions();
    expect(orphaned.some((s) => s.id === session.id)).toBe(true);
  });
});

describe("recoverSession", () => {
  it("resets session to ready with checkpoint data", () => {
    const session = createSession({ summary: "recover me" });
    updateSession(session.id, {
      stage: "implement",
      status: "running",
      claude_session_id: "claude-xyz",
      session_id: "ark-dead-session",
    });

    saveCheckpoint(session.id);

    // Simulate crash: session still says "running" but tmux is dead
    const result = recoverSession(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Recovered from checkpoint");

    const recovered = getSession(session.id)!;
    expect(recovered.status).toBe("ready");
    expect(recovered.session_id).toBeNull(); // dead tmux cleared
    expect(recovered.claude_session_id).toBe("claude-xyz"); // preserved for --resume
    expect(recovered.stage).toBe("implement"); // restored from checkpoint

    // Verify recovery event logged
    const events = getEvents(session.id, { type: "session_recovered" });
    expect(events.length).toBe(1);
    expect(events[0].data!.from_status).toBe("running");
    expect(events[0].data!.had_checkpoint).toBe(true);
  });

  it("recovers without checkpoint (uses current session state)", () => {
    const session = createSession({ summary: "no checkpoint recovery" });
    updateSession(session.id, {
      stage: "plan",
      status: "running",
      session_id: "ark-dead",
    });

    // No checkpoint saved — recover from current state
    const result = recoverSession(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("no checkpoint");

    const recovered = getSession(session.id)!;
    expect(recovered.status).toBe("ready");
    expect(recovered.session_id).toBeNull();
  });

  it("returns error for nonexistent session", () => {
    const result = recoverSession("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("preserves claude_session_id from session when no checkpoint", () => {
    const session = createSession({ summary: "preserve claude id" });
    updateSession(session.id, {
      stage: "work",
      status: "running",
      claude_session_id: "claude-from-session",
      session_id: "ark-dead",
    });

    const result = recoverSession(session.id);
    expect(result.ok).toBe(true);

    const recovered = getSession(session.id)!;
    expect(recovered.claude_session_id).toBe("claude-from-session");
  });
});
