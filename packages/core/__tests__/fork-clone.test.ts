/**
 * Tests for forkSession (shallow) and cloneSession (deep).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, setContext } from "../context.js";
import { createSession, getSession, updateSession } from "../store.js";
import { forkSession, cloneSession } from "../session.js";
import type { TestContext } from "../context.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });

describe("forkSession (shallow)", () => {
  it("creates a new session with same config", () => {
    const original = createSession({ summary: "original", repo: "my-repo" });
    updateSession(original.id, { flow: "bare", stage: "work", compute_name: "my-compute", group_name: "my-group" });

    const { ok, forkId } = forkSession(original.id);
    expect(ok).toBe(true);

    const forked = getSession(forkId);
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

    const { ok, forkId } = forkSession(original.id);
    expect(ok).toBe(true);

    const forked = getSession(forkId);
    expect(forked!.claude_session_id).toBeFalsy();
  });

  it("uses original name when no new name given", () => {
    const original = createSession({ summary: "my-task" });
    const { forkId } = forkSession(original.id);
    expect(getSession(forkId)!.summary).toBe("my-task");
  });

  it("uses provided name", () => {
    const original = createSession({ summary: "my-task" });
    const { forkId } = forkSession(original.id, "new-name");
    expect(getSession(forkId)!.summary).toBe("new-name");
  });

  it("returns ok: false for nonexistent session", () => {
    const { ok } = forkSession("s-nonexistent");
    expect(ok).toBe(false);
  });
});

describe("cloneSession (deep)", () => {
  it("creates a new session with same config", () => {
    const original = createSession({ summary: "original", repo: "my-repo" });
    updateSession(original.id, { flow: "bare", stage: "work", compute_name: "my-compute", group_name: "my-group" });

    const { ok, cloneId } = cloneSession(original.id);
    expect(ok).toBe(true);

    const cloned = getSession(cloneId);
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

    const { ok, cloneId } = cloneSession(original.id);
    expect(ok).toBe(true);

    const cloned = getSession(cloneId);
    expect(cloned!.claude_session_id).toBe("claude-abc-123");
  });

  it("returns ok: false for nonexistent session", () => {
    const { ok } = cloneSession("s-nonexistent");
    expect(ok).toBe(false);
  });
});
