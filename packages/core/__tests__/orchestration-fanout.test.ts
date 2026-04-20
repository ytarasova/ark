/**
 * Tests for fanOut, joinFork, spawnSubagent, spawnParallelSubagents, and handoff.
 *
 * These cover the orchestration functions that previously had no dedicated
 * tests beyond the basic fork/clone create-shape coverage.
 */

import { describe, it, expect, setDefaultTimeout } from "bun:test";

setDefaultTimeout(15_000);
import {
  fanOut,
  joinFork,
  fork,
  spawnSubagent,
  spawnParallelSubagents,
  checkAutoJoin,
} from "../services/session-orchestration.js";
import { withTestContext, waitFor } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("fanOut", () => {
  it("rejects an unknown parent", () => {
    const result = fanOut(getApp(), "s-nope", { tasks: [{ summary: "t" }] });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it("rejects an empty task list", () => {
    const parent = getApp().sessions.create({ summary: "parent" });
    const result = fanOut(getApp(), parent.id, { tasks: [] });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no tasks/i);
  });

  it("creates one child per task and parents them under the original session", () => {
    const parent = getApp().sessions.create({ summary: "parent", repo: "/x" });
    getApp().sessions.update(parent.id, { compute_name: "local", workdir: "/wd" });

    const result = fanOut(getApp(), parent.id, {
      tasks: [
        { summary: "task A", agent: "implementer" },
        { summary: "task B", agent: "implementer" },
        { summary: "task C", agent: "implementer" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.childIds).toHaveLength(3);

    const refreshedParent = getApp().sessions.get(parent.id)!;
    expect(refreshedParent.status).toBe("waiting");
    expect(refreshedParent.fork_group).toBeTruthy();

    for (const id of result.childIds!) {
      const child = getApp().sessions.get(id)!;
      expect(child.parent_id).toBe(parent.id);
      expect(child.fork_group).toBe(refreshedParent.fork_group);
      expect(child.repo).toBe("/x");
      expect(child.compute_name).toBe("local");
      expect(child.workdir).toBe("/wd");
      expect(child.status).toBe("ready");
      expect(child.agent).toBe("implementer");
    }
  });

  it("logs a fan_out event on the parent", () => {
    const parent = getApp().sessions.create({ summary: "parent" });
    fanOut(getApp(), parent.id, { tasks: [{ summary: "a" }, { summary: "b" }] });

    const events = getApp().events.list(parent.id);
    const fanOutEvent = events.find((e) => e.type === "fan_out");
    expect(fanOutEvent).toBeDefined();
    const data = fanOutEvent!.data as { childCount: number; forkGroup: string };
    expect(data.childCount).toBe(2);
    expect(data.forkGroup).toBeTruthy();
  });
});

describe("joinFork", () => {
  it("returns ok: false when there are no children", async () => {
    const parent = getApp().sessions.create({ summary: "lonely" });
    const result = await joinFork(getApp(), parent.id);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no children/i);
  });

  it("blocks when at least one child is still running and force is false", async () => {
    const parent = getApp().sessions.create({ summary: "parent" });
    const fan = fanOut(getApp(), parent.id, { tasks: [{ summary: "a" }, { summary: "b" }] });
    expect(fan.ok).toBe(true);
    // Mark only one child as completed
    getApp().sessions.update(fan.childIds![0], { status: "completed" });

    const result = await joinFork(getApp(), parent.id);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not done/i);
  });

  it("force=true joins even with incomplete children", async () => {
    const parent = getApp().sessions.create({ summary: "parent" });
    fanOut(getApp(), parent.id, { tasks: [{ summary: "a" }, { summary: "b" }] });

    const result = await joinFork(getApp(), parent.id, true);
    // The advance step may not succeed (no flow stages) but joinFork itself should
    // log the event and clear fork_group regardless.
    expect(getApp().sessions.get(parent.id)!.fork_group).toBeNull();
    const events = getApp().events.list(parent.id);
    expect(events.some((e) => e.type === "fork_joined")).toBe(true);
    expect(typeof result.ok).toBe("boolean");
  });
});

describe("checkAutoJoin", () => {
  it("returns false when child has no parent", async () => {
    const child = getApp().sessions.create({ summary: "orphan" });
    const advanced = await checkAutoJoin(getApp(), child.id);
    expect(advanced).toBe(false);
  });

  it("returns false when parent is not waiting", async () => {
    const parent = getApp().sessions.create({ summary: "parent" });
    const fan = fanOut(getApp(), parent.id, { tasks: [{ summary: "a" }] });
    // Move parent out of waiting
    getApp().sessions.update(parent.id, { status: "running" });
    getApp().sessions.update(fan.childIds![0], { status: "completed" });

    const advanced = await checkAutoJoin(getApp(), fan.childIds![0]);
    expect(advanced).toBe(false);
  });

  it("returns false while at least one sibling is still in flight", async () => {
    const parent = getApp().sessions.create({ summary: "parent" });
    const fan = fanOut(getApp(), parent.id, { tasks: [{ summary: "a" }, { summary: "b" }] });
    getApp().sessions.update(fan.childIds![0], { status: "completed" });
    // child[1] still running
    const advanced = await checkAutoJoin(getApp(), fan.childIds![0]);
    expect(advanced).toBe(false);
  });
});

describe("fork (single child)", () => {
  it("rejects an unknown parent", async () => {
    const result = await fork(getApp(), "s-nope", "do something");
    expect(result.ok).toBe(false);
  });

  it("creates a child with parent_id and fork_group set", async () => {
    const parent = getApp().sessions.create({ summary: "parent", repo: "/r" });
    const result = await fork(getApp(), parent.id, "subtask", { dispatch: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const child = getApp().sessions.get(result.sessionId)!;
    expect(child.parent_id).toBe(parent.id);
    expect(child.fork_group).toBeTruthy();
    expect(child.repo).toBe("/r");
    expect(child.summary).toBe("subtask");
    expect(child.status).toBe("ready");

    // Parent should now have the same fork_group
    const refreshedParent = getApp().sessions.get(parent.id)!;
    expect(refreshedParent.fork_group).toBe(child.fork_group);
  });

  it("reuses parent.fork_group on subsequent forks", async () => {
    const parent = getApp().sessions.create({ summary: "parent" });
    const a = await fork(getApp(), parent.id, "a", { dispatch: false });
    const b = await fork(getApp(), parent.id, "b", { dispatch: false });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const ca = getApp().sessions.get(a.sessionId)!;
    const cb = getApp().sessions.get(b.sessionId)!;
    expect(ca.fork_group).toBe(cb.fork_group);
  });
});

describe("spawnSubagent", () => {
  it("rejects an unknown parent", () => {
    const result = spawnSubagent(getApp(), "s-nope", { task: "x" });
    expect(result.ok).toBe(false);
  });

  it("creates a quick-flow child with subagent metadata", () => {
    const parent = getApp().sessions.create({ summary: "parent" });
    getApp().sessions.update(parent.id, { agent: "implementer", workdir: "/wd" });

    const result = spawnSubagent(getApp(), parent.id, {
      task: "doc this function",
      model: "haiku",
    });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeTruthy();

    const child = getApp().sessions.get(result.sessionId!)!;
    expect(child.flow).toBe("quick");
    expect(child.parent_id).toBe(parent.id);
    expect(child.workdir).toBe("/wd");
    expect(child.agent).toBe("implementer"); // inherits parent's agent
    expect(child.config?.subagent).toBe(true);
    expect(child.config?.model_override).toBe("haiku");
  });

  it("agent override takes precedence over the parent's agent", () => {
    const parent = getApp().sessions.create({ summary: "parent" });
    getApp().sessions.update(parent.id, { agent: "implementer" });

    const result = spawnSubagent(getApp(), parent.id, { task: "review", agent: "reviewer" });
    expect(result.ok).toBe(true);
    expect(getApp().sessions.get(result.sessionId!)!.agent).toBe("reviewer");
  });

  it("logs a subagent_spawned event", () => {
    const parent = getApp().sessions.create({ summary: "parent" });
    const result = spawnSubagent(getApp(), parent.id, { task: "x" });
    expect(result.ok).toBe(true);
    const events = getApp().events.list(result.sessionId!);
    expect(events.some((e) => e.type === "subagent_spawned")).toBe(true);
  });
});

describe("spawnParallelSubagents", () => {
  it("returns the list of spawned ids and logs events on each", async () => {
    const parent = getApp().sessions.create({ summary: "parent" });
    const result = await spawnParallelSubagents(getApp(), parent.id, [{ task: "a" }, { task: "b" }, { task: "c" }]);

    expect(result.ok).toBe(true);
    expect(result.sessionIds).toHaveLength(3);
    for (const id of result.sessionIds) {
      const events = getApp().events.list(id);
      expect(events.some((e) => e.type === "subagent_spawned")).toBe(true);
    }
  });
});
