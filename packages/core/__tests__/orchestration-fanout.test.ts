/**
 * Tests for fanOut, joinFork, spawnSubagent, spawnParallelSubagents, and handoff.
 *
 * These cover the orchestration functions that previously had no dedicated
 * tests beyond the basic fork/clone create-shape coverage.
 */

import { describe, it, expect, setDefaultTimeout } from "bun:test";

setDefaultTimeout(15_000);
import { fanOut, joinFork, fork, checkAutoJoin } from "../services/fork-join.js";
import { spawnSubagent, spawnParallelSubagents } from "../services/subagents.js";
import { withTestContext, waitFor } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("fanOut", () => {
  it("rejects an unknown parent", async () => {
    const result = await fanOut(getApp(), "s-nope", { tasks: [{ summary: "t" }] });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it("rejects an empty task list", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    const result = await fanOut(getApp(), parent.id, { tasks: [] });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no tasks/i);
  });

  it("creates one child per task and parents them under the original session", async () => {
    const parent = await getApp().sessions.create({ summary: "parent", repo: "/x" });
    await getApp().sessions.update(parent.id, { compute_name: "local", workdir: "/wd" });

    const result = await fanOut(getApp(), parent.id, {
      tasks: [
        { summary: "task A", agent: "implementer" },
        { summary: "task B", agent: "implementer" },
        { summary: "task C", agent: "implementer" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.childIds).toHaveLength(3);

    const refreshedParent = (await getApp().sessions.get(parent.id))!;
    expect(refreshedParent.status).toBe("waiting");
    expect(refreshedParent.fork_group).toBeTruthy();

    for (const id of result.childIds!) {
      const child = (await getApp().sessions.get(id))!;
      expect(child.parent_id).toBe(parent.id);
      expect(child.fork_group).toBe(refreshedParent.fork_group);
      expect(child.repo).toBe("/x");
      expect(child.compute_name).toBe("local");
      expect(child.workdir).toBe("/wd");
      expect(child.status).toBe("ready");
      expect(child.agent).toBe("implementer");
    }
  });

  it("logs a fan_out event on the parent", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    await fanOut(getApp(), parent.id, { tasks: [{ summary: "a" }, { summary: "b" }] });

    const events = await getApp().events.list(parent.id);
    const fanOutEvent = events.find((e) => e.type === "fan_out");
    expect(fanOutEvent).toBeDefined();
    const data = fanOutEvent!.data as { childCount: number; forkGroup: string };
    expect(data.childCount).toBe(2);
    expect(data.forkGroup).toBeTruthy();
  });
});

describe("joinFork", async () => {
  it("returns ok: false when there are no children", async () => {
    const parent = await getApp().sessions.create({ summary: "lonely" });
    const result = await joinFork(getApp(), parent.id);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no children/i);
  });

  it("blocks when at least one child is still running and force is false", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    const fan = await fanOut(getApp(), parent.id, { tasks: [{ summary: "a" }, { summary: "b" }] });
    expect(fan.ok).toBe(true);
    // Mark only one child as completed
    await getApp().sessions.update(fan.childIds![0], { status: "completed" });

    const result = await joinFork(getApp(), parent.id);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not done/i);
  });

  it("force=true joins even with incomplete children", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    await fanOut(getApp(), parent.id, { tasks: [{ summary: "a" }, { summary: "b" }] });

    const result = await joinFork(getApp(), parent.id, true);
    // The advance step may not succeed (no flow stages) but joinFork itself should
    // log the event and clear fork_group regardless.
    expect((await getApp().sessions.get(parent.id))!.fork_group).toBeNull();
    const events = await getApp().events.list(parent.id);
    expect(events.some((e) => e.type === "fork_joined")).toBe(true);
    expect(typeof result.ok).toBe("boolean");
  });
});

describe("checkAutoJoin", async () => {
  it("returns false when child has no parent", async () => {
    const child = await getApp().sessions.create({ summary: "orphan" });
    const advanced = await checkAutoJoin(getApp(), child.id);
    expect(advanced).toBe(false);
  });

  it("returns false when parent is not waiting", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    const fan = await fanOut(getApp(), parent.id, { tasks: [{ summary: "a" }] });
    // Move parent out of waiting
    await getApp().sessions.update(parent.id, { status: "running" });
    await getApp().sessions.update(fan.childIds![0], { status: "completed" });

    const advanced = await checkAutoJoin(getApp(), fan.childIds![0]);
    expect(advanced).toBe(false);
  });

  it("returns false while at least one sibling is still in flight", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    const fan = await fanOut(getApp(), parent.id, { tasks: [{ summary: "a" }, { summary: "b" }] });
    await getApp().sessions.update(fan.childIds![0], { status: "completed" });
    // child[1] still running
    const advanced = await checkAutoJoin(getApp(), fan.childIds![0]);
    expect(advanced).toBe(false);
  });
});

describe("fork (single child)", async () => {
  it("rejects an unknown parent", async () => {
    const result = await fork(getApp(), "s-nope", "do something");
    expect(result.ok).toBe(false);
  });

  it("creates a child with parent_id and fork_group set", async () => {
    const parent = await getApp().sessions.create({ summary: "parent", repo: "/r" });
    const result = await fork(getApp(), parent.id, "subtask", { dispatch: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const child = (await getApp().sessions.get(result.sessionId))!;
    expect(child.parent_id).toBe(parent.id);
    expect(child.fork_group).toBeTruthy();
    expect(child.repo).toBe("/r");
    expect(child.summary).toBe("subtask");
    expect(child.status).toBe("ready");

    // Parent should now have the same fork_group
    const refreshedParent = (await getApp().sessions.get(parent.id))!;
    expect(refreshedParent.fork_group).toBe(child.fork_group);
  });

  it("reuses parent.fork_group on subsequent forks", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    const a = await fork(getApp(), parent.id, "a", { dispatch: false });
    const b = await fork(getApp(), parent.id, "b", { dispatch: false });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const ca = (await getApp().sessions.get(a.sessionId))!;
    const cb = (await getApp().sessions.get(b.sessionId))!;
    expect(ca.fork_group).toBe(cb.fork_group);
  });
});

describe("spawnSubagent", async () => {
  it("rejects an unknown parent", async () => {
    const result = await spawnSubagent(getApp(), "s-nope", { task: "x" });
    expect(result.ok).toBe(false);
  });

  it("creates a quick-flow child with subagent metadata", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    await getApp().sessions.update(parent.id, { agent: "implementer", workdir: "/wd" });

    const result = await spawnSubagent(getApp(), parent.id, {
      task: "doc this function",
    });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeTruthy();

    const child = (await getApp().sessions.get(result.sessionId!))!;
    expect(child.flow).toBe("quick");
    expect(child.parent_id).toBe(parent.id);
    expect(child.workdir).toBe("/wd");
    expect(child.agent).toBe("implementer"); // inherits parent's agent
    expect(child.config?.subagent).toBe(true);
  });

  it("agent override takes precedence over the parent's agent", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    await getApp().sessions.update(parent.id, { agent: "implementer" });

    const result = await spawnSubagent(getApp(), parent.id, { task: "review", agent: "reviewer" });
    expect(result.ok).toBe(true);
    expect((await getApp().sessions.get(result.sessionId!))!.agent).toBe("reviewer");
  });

  it("logs a subagent_spawned event", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    const result = await spawnSubagent(getApp(), parent.id, { task: "x" });
    expect(result.ok).toBe(true);
    const events = await getApp().events.list(result.sessionId!);
    expect(events.some((e) => e.type === "subagent_spawned")).toBe(true);
  });
});

describe("spawnParallelSubagents", async () => {
  it("returns the list of spawned ids and logs events on each", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    const result = await spawnParallelSubagents(getApp(), parent.id, [{ task: "a" }, { task: "b" }, { task: "c" }]);

    expect(result.ok).toBe(true);
    expect(result.sessionIds).toHaveLength(3);
    for (const id of result.sessionIds) {
      const events = await getApp().events.list(id);
      expect(events.some((e) => e.type === "subagent_spawned")).toBe(true);
    }
  });
});
