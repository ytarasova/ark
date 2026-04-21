import { describe, it, expect, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

setDefaultTimeout(15_000);
import { fanOut, checkAutoJoin, joinFork, dispatch, extractSubtasks } from "../services/session-orchestration.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("extractSubtasks", () => {
  it("returns default implementation + tests when no PLAN.md exists", async () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "Build auth system", flow: "bare" });
    const subtasks = await extractSubtasks(app, session);

    expect(subtasks).toHaveLength(2);
    expect(subtasks[0].name).toBe("implementation");
    expect(subtasks[0].task).toContain("Implement");
    expect(subtasks[0].task).toContain("Build auth system");
    expect(subtasks[1].name).toBe("tests");
    expect(subtasks[1].task).toContain("Write tests");
  });

  it("parses PLAN.md steps when present", async () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "Big feature", flow: "bare" });

    const wtDir = join(app.config.worktreesDir, session.id);
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(
      join(wtDir, "PLAN.md"),
      [
        "# Plan",
        "",
        "## Step 1: Set up database schema",
        "Create the tables for users and roles.",
        "",
        "## Step 2: Implement API endpoints",
        "REST endpoints for CRUD operations.",
        "",
        "## Step 3: Add authentication middleware",
        "JWT validation on protected routes.",
      ].join("\n"),
    );

    const subtasks = await extractSubtasks(app, session);
    expect(subtasks).toHaveLength(3);
    expect(subtasks[0].name).toBe("step-1");
    expect(subtasks[0].task).toContain("Set up database schema");
    expect(subtasks[1].name).toBe("step-2");
    expect(subtasks[1].task).toContain("Implement API endpoints");
    expect(subtasks[2].name).toBe("step-3");
    expect(subtasks[2].task).toContain("Add authentication middleware");
  });

  it("falls back to defaults when PLAN.md has fewer than 2 steps", async () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "Simple fix", flow: "bare" });

    const wtDir = join(app.config.worktreesDir, session.id);
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "PLAN.md"), "# Plan\n\n## Step 1: Fix the bug\nJust do it.\n");

    const subtasks = await extractSubtasks(app, session);
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0].name).toBe("implementation");
  });

  it("uses 'the task' when session has no summary", async () => {
    const app = getApp();
    const session = app.sessions.create({ flow: "bare" });
    const subtasks = await extractSubtasks(app, session);

    expect(subtasks[0].task).toContain("the task");
  });

  it("handles numbered headings without Step prefix", async () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "Feature", flow: "bare" });

    const wtDir = join(app.config.worktreesDir, session.id);
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(
      join(wtDir, "PLAN.md"),
      ["# Plan", "", "## 1. First thing", "Details.", "", "## 2. Second thing", "More details."].join("\n"),
    );

    const subtasks = await extractSubtasks(app, session);
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0].task).toContain("First thing");
    expect(subtasks[1].task).toContain("Second thing");
  });
});

describe("dispatch with fan_out stage", () => {
  it("dispatch on fan_out stage creates children and sets parent to waiting", async () => {
    const app = getApp();
    const parent = app.sessions.create({ summary: "Test dispatch fan-out", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "ready" });

    const result = await dispatch(app, parent.id);
    expect(result.ok).toBe(true);

    const updated = app.sessions.get(parent.id);
    expect(updated!.status).toBe("waiting");

    const children = app.sessions.getChildren(parent.id);
    expect(children.length).toBeGreaterThan(0);

    for (const child of children) {
      expect(child.parent_id).toBe(parent.id);
      expect(child.fork_group).toBeTruthy();
    }

    await app.sessionService.stopAll();
  }, 30_000);

  it("fan_out children share the same fork_group as parent", async () => {
    const app = getApp();
    const parent = app.sessions.create({ summary: "Fork group test", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "ready" });

    await dispatch(app, parent.id);

    const updated = app.sessions.get(parent.id)!;
    const children = app.sessions.getChildren(parent.id);
    expect(children.length).toBeGreaterThan(0);

    for (const child of children) {
      expect(child.fork_group).toBe(updated.fork_group);
    }

    await app.sessionService.stopAll();
  }, 30_000);
});

describe("fan-out lifecycle integration", () => {
  it("second fan-out on same parent replaces fork_group", async () => {
    const app = getApp();
    const parent = app.sessions.create({ summary: "Multi fan-out", flow: "bare" });

    const r1 = fanOut(app, parent.id, { tasks: [{ summary: "A" }] });
    const fg1 = app.sessions.get(parent.id)!.fork_group;

    app.sessions.update(parent.id, { status: "running", fork_group: null });
    const r2 = fanOut(app, parent.id, { tasks: [{ summary: "B" }] });
    const fg2 = app.sessions.get(parent.id)!.fork_group;

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(fg1).not.toBe(fg2);
  });

  it("auto-join advances parent through flow stages", async () => {
    const app = getApp();
    const parent = app.sessions.create({ summary: "Auto-advance", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "Only child" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(true);

    const parentState = app.sessions.get(parent.id)!;
    expect(parentState.fork_group).toBeNull();
    expect(parentState.status).not.toBe("waiting");
  });

  it("checkAutoJoin with mix of completed and failed children still joins", async () => {
    const app = getApp();
    const parent = app.sessions.create({ summary: "Mixed results", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "Good" }, { summary: "Bad" }, { summary: "Also good" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed" });
    app.sessions.update(result.childIds![2], { status: "completed" });

    const joined = await checkAutoJoin(app, result.childIds![2]);
    expect(joined).toBe(true);

    const events = app.events.list(parent.id);
    const partialFail = events.find((e) => e.type === "fan_out_partial_failure");
    expect(partialFail).toBeTruthy();
    expect(partialFail!.data?.failed).toHaveLength(1);
    expect(partialFail!.data?.total).toBe(3);

    const joinEvent = events.find((e) => e.type === "auto_join");
    expect(joinEvent).toBeTruthy();
    expect(joinEvent!.data?.children).toBe(3);
    expect(joinEvent!.data?.failed).toBe(1);
  });

  it("joinFork clears fork_group and logs fork_joined event", async () => {
    const app = getApp();
    const parent = app.sessions.create({ summary: "Join test", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "completed" });

    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(true);

    const parentState = app.sessions.get(parent.id)!;
    expect(parentState.fork_group).toBeNull();

    const events = app.events.list(parent.id);
    expect(events.some((e) => e.type === "fork_joined")).toBe(true);
  });

  it("children inherit compute context through fan-out", async () => {
    const app = getApp();
    const parent = app.sessions.create({ summary: "Compute inherit", flow: "bare" });
    app.sessions.update(parent.id, {
      compute_name: "my-docker",
      workdir: "/workspace/project",
      repo: "org/repo",
    });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "Child 1" }, { summary: "Child 2" }],
    });

    for (const childId of result.childIds!) {
      const child = app.sessions.get(childId)!;
      expect(child.compute_name).toBe("my-docker");
      expect(child.workdir).toBe("/workspace/project");
      expect(child.repo).toBe("org/repo");
    }
  });

  it("fan-out with custom flows assigns correct flow per child", async () => {
    const app = getApp();
    const parent = app.sessions.create({ summary: "Mixed flows", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "Quick task", flow: "quick" },
        { summary: "Bare task", flow: "bare" },
        { summary: "Default flow task" },
      ],
    });

    expect(result.ok).toBe(true);
    const children = result.childIds!.map((id) => app.sessions.get(id)!);
    expect(children[0].flow).toBe("quick");
    expect(children[1].flow).toBe("bare");
    expect(children[2].flow).toBe("bare");
  });

  it("fan-out with custom agents assigns correct agent per child", async () => {
    const app = getApp();
    const parent = app.sessions.create({ summary: "Mixed agents", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "Review this", agent: "reviewer" },
        { summary: "Implement that", agent: "implementer" },
        { summary: "No specific agent" },
      ],
    });

    expect(result.ok).toBe(true);
    const children = result.childIds!.map((id) => app.sessions.get(id)!);
    expect(children[0].agent).toBe("reviewer");
    expect(children[1].agent).toBe("implementer");
    expect(children[2].agent).toBeNull();
  });

  it("getChildren returns only direct children, not grandchildren", async () => {
    const app = getApp();
    const grandparent = app.sessions.create({ summary: "Grandparent", flow: "bare" });
    const parentResult = fanOut(app, grandparent.id, {
      tasks: [{ summary: "Parent child" }],
    });

    const parentChildId = parentResult.childIds![0];
    app.sessions.update(parentChildId, { status: "running" });

    fanOut(app, parentChildId, {
      tasks: [{ summary: "Grandchild" }],
    });

    const grandparentChildren = app.sessions.getChildren(grandparent.id);
    expect(grandparentChildren).toHaveLength(1);
    expect(grandparentChildren[0].id).toBe(parentChildId);

    const parentChildren = app.sessions.getChildren(parentChildId);
    expect(parentChildren).toHaveLength(1);
    expect(parentChildren[0].summary).toBe("Grandchild");
  });
});
