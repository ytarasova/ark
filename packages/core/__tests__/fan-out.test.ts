import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { fanOut, checkAutoJoin, spawnSubagent, spawnParallelSubagents, joinFork } from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

describe("sub-agent fan-out", () => {
  it("creates correct number of children", () => {
    const parent = app.sessions.create({ summary: "build feature", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "Implement auth module", agent: "implementer" },
        { summary: "Write auth tests", agent: "implementer" },
        { summary: "Update docs", agent: "documenter" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.childIds).toHaveLength(3);
  });

  it("children linked to parent", () => {
    const parent = app.sessions.create({ summary: "build feature", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "task A" },
        { summary: "task B" },
      ],
    });

    for (const childId of result.childIds!) {
      const child = app.sessions.get(childId)!;
      expect(child.parent_id).toBe(parent.id);
      expect(child.status).toBe("ready");
    }
  });

  it("children share fork_group", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare" });
    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "task 1" },
        { summary: "task 2" },
      ],
    });

    const child1 = app.sessions.get(result.childIds![0])!;
    const child2 = app.sessions.get(result.childIds![1])!;
    expect(child1.fork_group).toBeDefined();
    expect(child1.fork_group).toBe(child2.fork_group);
  });

  it("parent in waiting state", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare" });
    fanOut(app, parent.id, {
      tasks: [{ summary: "task 1" }],
    });

    const updated = app.sessions.get(parent.id)!;
    expect(updated.status).toBe("waiting");
  });

  it("empty task list rejected", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare" });
    const result = fanOut(app, parent.id, { tasks: [] });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("No tasks provided");
  });

  it("missing parent returns error", () => {
    const result = fanOut(app, "s-nonexistent", {
      tasks: [{ summary: "task" }],
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("children inherit parent repo and workdir", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare" });
    app.sessions.update(parent.id, { repo: "my-repo", workdir: "/tmp/repo" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child task" }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    expect(child.repo).toBe("my-repo");
    expect(child.workdir).toBe("/tmp/repo");
  });

  it("children inherit parent group_name", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare", group_name: "my-group" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child task" }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    expect(child.group_name).toBe("my-group");
  });

  it("children use custom agent when specified", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "review task", agent: "reviewer" },
        { summary: "doc task", agent: "documenter" },
      ],
    });

    const child1 = app.sessions.get(result.childIds![0])!;
    const child2 = app.sessions.get(result.childIds![1])!;
    expect(child1.agent).toBe("reviewer");
    expect(child2.agent).toBe("documenter");
  });

  it("children use custom flow when specified", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child", flow: "quick" }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    expect(child.flow).toBe("quick");
  });

  it("children default to bare flow", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child" }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    expect(child.flow).toBe("bare");
  });

  it("parent fork_group matches children fork_group", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    const updatedParent = app.sessions.get(parent.id)!;
    const child = app.sessions.get(result.childIds![0])!;
    expect(updatedParent.fork_group).toBe(child.fork_group);
  });

  it("logs fan_out event on parent", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    const events = app.events.list(parent.id);
    const fanOutEvent = events.find((e) => e.type === "fan_out");
    expect(fanOutEvent).toBeTruthy();
    expect(fanOutEvent!.data?.childCount).toBe(2);
    expect(fanOutEvent!.data?.forkGroup).toBeTruthy();
  });

  it("getChildren returns all fan-out children", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare" });

    fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }, { summary: "C" }],
    });

    const children = app.sessions.getChildren(parent.id);
    expect(children).toHaveLength(3);
  });

  it("handles large fan-out (10 children)", () => {
    const parent = app.sessions.create({ summary: "big fan-out", flow: "bare" });
    const tasks = Array.from({ length: 10 }, (_, i) => ({ summary: `Task ${i}` }));

    const result = fanOut(app, parent.id, { tasks });
    expect(result.ok).toBe(true);
    expect(result.childIds).toHaveLength(10);

    const children = app.sessions.getChildren(parent.id);
    expect(children).toHaveLength(10);

    // All share the same fork_group
    const groups = new Set(children.map((c) => c.fork_group));
    expect(groups.size).toBe(1);
  });

  it("multiple fan-outs on different parents are independent", () => {
    const parent1 = app.sessions.create({ summary: "parent 1", flow: "bare" });
    const parent2 = app.sessions.create({ summary: "parent 2", flow: "bare" });

    const r1 = fanOut(app, parent1.id, { tasks: [{ summary: "A" }] });
    const r2 = fanOut(app, parent2.id, { tasks: [{ summary: "B" }] });

    const child1 = app.sessions.get(r1.childIds![0])!;
    const child2 = app.sessions.get(r2.childIds![0])!;

    expect(child1.parent_id).toBe(parent1.id);
    expect(child2.parent_id).toBe(parent2.id);
    expect(child1.fork_group).not.toBe(child2.fork_group);
  });
});

describe("checkAutoJoin", () => {
  it("returns false when child has no parent", async () => {
    const session = app.sessions.create({ summary: "orphan", flow: "bare" });
    const result = await checkAutoJoin(app, session.id);
    expect(result).toBe(false);
  });

  it("returns false when parent is not waiting", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child" }],
    });

    // Manually set parent back to running (not waiting)
    app.sessions.update(parent.id, { status: "running" });
    app.sessions.update(result.childIds![0], { status: "completed" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(false);
  });

  it("returns false when some children still running", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    // Only complete first child
    app.sessions.update(result.childIds![0], { status: "completed" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(false);

    // Parent still waiting
    const parentState = app.sessions.get(parent.id)!;
    expect(parentState.status).toBe("waiting");
  });

  it("joins when all children completed", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "completed" });

    const joined = await checkAutoJoin(app, result.childIds![1]);
    expect(joined).toBe(true);

    const parentState = app.sessions.get(parent.id)!;
    expect(parentState.status).not.toBe("waiting");
    expect(parentState.fork_group).toBeNull();
  });

  it("joins when all children failed", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }],
    });

    app.sessions.update(result.childIds![0], { status: "failed" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(true);
  });

  it("logs auto_join event on parent", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    await checkAutoJoin(app, result.childIds![0]);

    const events = app.events.list(parent.id);
    const joinEvent = events.find((e) => e.type === "auto_join");
    expect(joinEvent).toBeTruthy();
    expect(joinEvent!.data?.children).toBe(1);
    expect(joinEvent!.data?.failed).toBe(0);
  });

  it("logs partial failure when some children failed", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "pass" }, { summary: "fail" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed" });

    await checkAutoJoin(app, result.childIds![0]);

    const events = app.events.list(parent.id);
    const failEvent = events.find((e) => e.type === "fan_out_partial_failure");
    expect(failEvent).toBeTruthy();
    expect(failEvent!.data?.failed).toHaveLength(1);
    expect(failEvent!.data?.total).toBe(2);
  });

  it("returns false for nonexistent session", async () => {
    const result = await checkAutoJoin(app, "s-nonexistent");
    expect(result).toBe(false);
  });
});

describe("joinFork", () => {
  it("joins when all children completed", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "completed" });

    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(true);
  });

  it("fails when children not done and no force", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    // Leave second child as ready

    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(false);
    expect(joinResult.message).toContain("not done");
  });

  it("force join succeeds with incomplete children", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    // Don't complete any children
    const joinResult = await joinFork(app, parent.id, true);
    expect(joinResult.ok).toBe(true);
  });

  it("fails when no children exist", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });

    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(false);
    expect(joinResult.message).toContain("No children");
  });

  it("blocks when children failed without force", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed" });

    // joinFork only considers "completed" as done, so failed child blocks
    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(false);
    expect(joinResult.message).toContain("not done");
  });

  it("force join succeeds with failed children", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }],
    });

    app.sessions.update(result.childIds![0], { status: "failed" });

    const joinResult = await joinFork(app, parent.id, true);
    expect(joinResult.ok).toBe(true);
  });

  it("clears fork_group on parent after join", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    fanOut(app, parent.id, {
      tasks: [{ summary: "A" }],
    });

    // Verify parent has fork_group
    let parentState = app.sessions.get(parent.id)!;
    expect(parentState.fork_group).toBeTruthy();

    app.sessions.update(app.sessions.getChildren(parent.id)[0].id, { status: "completed" });
    await joinFork(app, parent.id);

    parentState = app.sessions.get(parent.id)!;
    expect(parentState.fork_group).toBeNull();
  });
});

describe("spawnSubagent", () => {
  it("creates child linked to parent", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = spawnSubagent(app, parent.id, { task: "Do subtask" });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeTruthy();

    const child = app.sessions.get(result.sessionId!)!;
    expect(child.parent_id).toBe(parent.id);
    expect(child.summary).toBe("Do subtask");
  });

  it("inherits parent compute and workdir", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, {
      status: "running", compute_name: "ec2-box", workdir: "/home/ubuntu/repo",
    });

    const result = spawnSubagent(app, parent.id, { task: "subtask" });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.compute_name).toBe("ec2-box");
    expect(child.workdir).toBe("/home/ubuntu/repo");
  });

  it("uses quick flow by default", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });

    const result = spawnSubagent(app, parent.id, { task: "subtask" });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.flow).toBe("quick");
  });

  it("overrides agent when specified", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { agent: "implementer" });

    const result = spawnSubagent(app, parent.id, {
      task: "review this", agent: "reviewer",
    });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.agent).toBe("reviewer");
  });

  it("inherits parent agent when not overridden", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { agent: "implementer" });

    const result = spawnSubagent(app, parent.id, { task: "subtask" });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.agent).toBe("implementer");
  });

  it("stores model override in config", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });

    const result = spawnSubagent(app, parent.id, {
      task: "cheap task", model: "haiku",
    });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.config?.model_override).toBe("haiku");
  });

  it("logs subagent_spawned event", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { agent: "implementer" });

    const result = spawnSubagent(app, parent.id, {
      task: "do thing", model: "haiku",
    });

    const events = app.events.list(result.sessionId!);
    const spawnEvent = events.find((e) => e.type === "subagent_spawned");
    expect(spawnEvent).toBeTruthy();
    expect(spawnEvent!.data?.parent_id).toBe(parent.id);
    expect(spawnEvent!.data?.model).toBe("haiku");
  });

  it("stores extensions in config", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });

    const result = spawnSubagent(app, parent.id, {
      task: "subtask with MCP", extensions: ["slack", "github"],
    });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.config?.extensions).toEqual(["slack", "github"]);
  });

  it("sets subagent flag in config", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });

    const result = spawnSubagent(app, parent.id, { task: "subtask" });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.config?.subagent).toBe(true);
  });

  it("child is in ready state with first stage set", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });

    const result = spawnSubagent(app, parent.id, { task: "subtask" });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.status).toBe("ready");
    expect(child.stage).toBeTruthy();
  });

  it("fails for nonexistent parent", () => {
    const result = spawnSubagent(app, "s-nonexistent", { task: "subtask" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("inherits parent group_name", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare", group_name: "team-a" });

    const result = spawnSubagent(app, parent.id, { task: "subtask" });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.group_name).toBe("team-a");
  });

  it("overrides group_name when specified", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare", group_name: "team-a" });

    const result = spawnSubagent(app, parent.id, {
      task: "subtask", group_name: "team-b",
    });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.group_name).toBe("team-b");
  });
});

describe("spawnParallelSubagents", () => {
  it("spawns multiple subagents", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = await spawnParallelSubagents(app, parent.id, [
      { task: "Task 1" },
      { task: "Task 2" },
      { task: "Task 3" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.sessionIds).toHaveLength(3);

    for (const id of result.sessionIds) {
      const child = app.sessions.get(id)!;
      expect(child.parent_id).toBe(parent.id);
    }
  });

  it("each subagent can have different model overrides", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const r1 = spawnSubagent(app, parent.id, { task: "Review" });
    const r2 = spawnSubagent(app, parent.id, { task: "Docs", model: "haiku" });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const child1 = app.sessions.get(r1.sessionId!)!;
    const child2 = app.sessions.get(r2.sessionId!)!;
    // Both children are linked to parent
    expect(child1.parent_id).toBe(parent.id);
    expect(child2.parent_id).toBe(parent.id);
    // Model override stored in config
    expect(child2.config?.model_override).toBe("haiku");
  });
});
