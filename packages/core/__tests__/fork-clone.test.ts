/**
 * Tests for forkSession (shallow) and cloneSession (deep).
 */

import { describe, it, expect } from "bun:test";
import { createSession, getSession, updateSession } from "../store.js";
import { forkSession, cloneSession } from "../services/session-orchestration.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("forkSession (shallow)", () => {
  it("creates a new session with same config", () => {
    const original = createSession({ summary: "original", repo: "my-repo" });
    updateSession(original.id, { flow: "bare", stage: "work", compute_name: "my-compute", group_name: "my-group" });

    const result = forkSession(original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const forked = getSession(result.sessionId);
    expect(forked).not.toBeNull();
    expect(forked!.repo).toBe("my-repo");
    expect(forked!.flow).toBe("bare");
    expect(forked!.stage).toBe("work");
    expect(forked!.compute_name).toBe("my-compute");
    expect(forked!.group_name).toBe("my-group");
    expect(forked!.status).toBe("ready");
  });

  it("does NOT copy claude_session_id", () => {
    const original = createSession({ summary: "has-claude" });
    updateSession(original.id, { claude_session_id: "claude-abc-123" });

    const result = forkSession(original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const forked = getSession(result.sessionId);
    expect(forked!.claude_session_id).toBeFalsy();
  });

  it("auto-generates unique name when no new name given", () => {
    const original = createSession({ summary: "my-task" });
    const result = forkSession(original.id);
    if (!result.ok) return;
    expect(getSession(result.sessionId)!.summary).toBe("my-task (fork)");
  });

  it("uses provided name", () => {
    const original = createSession({ summary: "my-task" });
    const result = forkSession(original.id, "new-name");
    if (!result.ok) return;
    expect(getSession(result.sessionId)!.summary).toBe("new-name");
  });

  it("returns ok: false for nonexistent session", () => {
    const result = forkSession("s-nonexistent");
    expect(result.ok).toBe(false);
  });
});

describe("cloneSession (deep)", () => {
  it("creates a new session with same config", () => {
    const original = createSession({ summary: "original", repo: "my-repo" });
    updateSession(original.id, { flow: "bare", stage: "work", compute_name: "my-compute", group_name: "my-group" });

    const result = cloneSession(original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cloned = getSession(result.sessionId);
    expect(cloned!.repo).toBe("my-repo");
    expect(cloned!.flow).toBe("bare");
    expect(cloned!.stage).toBe("work");
    expect(cloned!.compute_name).toBe("my-compute");
    expect(cloned!.group_name).toBe("my-group");
    expect(cloned!.status).toBe("ready");
  });

  it("DOES copy claude_session_id for resume", () => {
    const original = createSession({ summary: "has-claude" });
    updateSession(original.id, { claude_session_id: "claude-abc-123" });

    const result = cloneSession(original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cloned = getSession(result.sessionId);
    expect(cloned!.claude_session_id).toBe("claude-abc-123");
  });

  it("returns ok: false for nonexistent session", () => {
    const result = cloneSession("s-nonexistent");
    expect(result.ok).toBe(false);
  });
});
