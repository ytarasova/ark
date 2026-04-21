/**
 * Tests for forkSession (shallow) and cloneSession (deep).
 */

import { describe, it, expect } from "bun:test";
import { forkSession, cloneSession } from "../services/session-orchestration.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("forkSession (shallow)", () => {
  it("creates a new session with same config", async () => {
    const original = await getApp().sessions.create({ summary: "original", repo: "my-repo" });
    await getApp().sessions.update(original.id, {
      flow: "bare",
      stage: "work",
      compute_name: "my-compute",
      group_name: "my-group",
    });

    const result = await forkSession(getApp(), original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const forked = await getApp().sessions.get(result.sessionId);
    expect(forked).not.toBeNull();
    expect(forked!.repo).toBe("my-repo");
    expect(forked!.flow).toBe("bare");
    expect(forked!.stage).toBe("work");
    expect(forked!.compute_name).toBe("my-compute");
    expect(forked!.group_name).toBe("my-group");
    expect(forked!.status).toBe("ready");
  });

  it("does NOT copy claude_session_id", async () => {
    const original = await getApp().sessions.create({ summary: "has-claude" });
    await getApp().sessions.update(original.id, { claude_session_id: "claude-abc-123" });

    const result = await forkSession(getApp(), original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const forked = await getApp().sessions.get(result.sessionId);
    expect(forked!.claude_session_id).toBeFalsy();
  });

  it("auto-generates unique name when no new name given", async () => {
    const original = await getApp().sessions.create({ summary: "my-task" });
    const result = await forkSession(getApp(), original.id);
    if (!result.ok) return;
    expect((await getApp().sessions.get(result.sessionId))!.summary).toBe("my-task (fork)");
  });

  it("uses provided name", async () => {
    const original = await getApp().sessions.create({ summary: "my-task" });
    const result = await forkSession(getApp(), original.id, "new-name");
    if (!result.ok) return;
    expect((await getApp().sessions.get(result.sessionId))!.summary).toBe("new-name");
  });

  it("returns ok: false for nonexistent session", async () => {
    const result = await forkSession(getApp(), "s-nonexistent");
    expect(result.ok).toBe(false);
  });
});

describe("cloneSession (deep)", () => {
  it("creates a new session with same config", async () => {
    const original = await getApp().sessions.create({ summary: "original", repo: "my-repo" });
    await getApp().sessions.update(original.id, {
      flow: "bare",
      stage: "work",
      compute_name: "my-compute",
      group_name: "my-group",
    });

    const result = await cloneSession(getApp(), original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cloned = await getApp().sessions.get(result.sessionId);
    expect(cloned!.repo).toBe("my-repo");
    expect(cloned!.flow).toBe("bare");
    expect(cloned!.stage).toBe("work");
    expect(cloned!.compute_name).toBe("my-compute");
    expect(cloned!.group_name).toBe("my-group");
    expect(cloned!.status).toBe("ready");
  });

  it("DOES copy claude_session_id for resume", async () => {
    const original = await getApp().sessions.create({ summary: "has-claude" });
    await getApp().sessions.update(original.id, { claude_session_id: "claude-abc-123" });

    const result = await cloneSession(getApp(), original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cloned = await getApp().sessions.get(result.sessionId);
    expect(cloned!.claude_session_id).toBe("claude-abc-123");
  });

  it("returns ok: false for nonexistent session", async () => {
    const result = await cloneSession(getApp(), "s-nonexistent");
    expect(result.ok).toBe(false);
  });
});
