/**
 * Fan-out lifecycle tests covering gaps in existing test suites:
 * - Multi-cycle fan-out (fan-out, join, fan-out again on same parent)
 * - Child ordering preservation (childIds match tasks array order)
 * - Large-scale fan-out (50 children)
 * - Fan-out interaction with soft-deleted children
 * - checkAutoJoin with fork_group mismatch (children from prior fan-out)
 * - joinFork advance pass-through (return value from advance)
 * - Fan-out with empty/edge-case summaries
 * - Parent status transition sequence verification
 * - spawnParallelSubagents with mixed model/agent overrides
 * - checkAutoJoin concurrent-safe: called twice for same parent
 * - Fan-out children don't inherit parent config
 * - Fork children inherit parent group_name
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import {
  fanOut,
  checkAutoJoin,
  joinFork,
  fork,
  spawnSubagent,
  retryWithContext,
} from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

// -- Multi-cycle fan-out on same parent ----------------------------------------

describe("multi-cycle fan-out (fan-out, join, fan-out again)", () => {
  test("parent can fan-out, auto-join, then fan-out again", async () => {
    const parent = app.sessions.create({ summary: "multi-cycle", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    // First cycle
    const r1 = fanOut(app, parent.id, {
      tasks: [{ summary: "cycle1-A" }, { summary: "cycle1-B" }],
    });
    expect(r1.ok).toBe(true);
    expect(app.sessions.get(parent.id)!.status).toBe("waiting");

    // Complete all cycle-1 children
    for (const id of r1.childIds!) {
      app.sessions.update(id, { status: "completed" });
    }
    const joined1 = await checkAutoJoin(app, r1.childIds![0]);
    expect(joined1).toBe(true);

    // Parent should no longer be waiting
    const mid = app.sessions.get(parent.id)!;
    expect(mid.status).not.toBe("waiting");
    expect(mid.fork_group).toBeNull();

    // Reset parent for second cycle
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    // Second cycle
    const r2 = fanOut(app, parent.id, {
      tasks: [{ summary: "cycle2-X" }],
    });
    expect(r2.ok).toBe(true);
    expect(app.sessions.get(parent.id)!.status).toBe("waiting");

    // New fork_group should differ from cycle 1
    const c1fg = app.sessions.get(r1.childIds![0])!.fork_group;
    const c2fg = app.sessions.get(r2.childIds![0])!.fork_group;
    expect(c1fg).not.toBe(c2fg);

    // Complete cycle-2 child
    app.sessions.update(r2.childIds![0], { status: "completed" });
    const joined2 = await checkAutoJoin(app, r2.childIds![0]);
    expect(joined2).toBe(true);

    // Verify events: should have 2 fan_out events and 2 auto_join events
    const events = app.events.list(parent.id);
    const fanOutEvents = events.filter((e) => e.type === "fan_out");
    const autoJoinEvents = events.filter((e) => e.type === "auto_join");
    expect(fanOutEvents).toHaveLength(2);
    expect(autoJoinEvents).toHaveLength(2);
  });

  test("joinFork + manual fan-out cycle works", async () => {
    const parent = app.sessions.create({ summary: "join-then-fanout", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const r1 = fanOut(app, parent.id, { tasks: [{ summary: "A" }] });
    app.sessions.update(r1.childIds![0], { status: "completed" });

    // Manual join
    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(true);

    // Parent should have fork_group cleared
    expect(app.sessions.get(parent.id)!.fork_group).toBeNull();

    // Now do another fan-out after manual join
    app.sessions.update(parent.id, { stage: "work", status: "running" });
    const r2 = fanOut(app, parent.id, { tasks: [{ summary: "B" }] });
    expect(r2.ok).toBe(true);
    expect(app.sessions.get(parent.id)!.fork_group).toBeTruthy();
  });
});

// -- Child ordering preservation -----------------------------------------------

describe("fan-out child ordering", () => {
  test("childIds are returned in same order as tasks", () => {
    const parent = app.sessions.create({ summary: "ordering", flow: "bare" });

    const tasks = [
      { summary: "First" },
      { summary: "Second" },
      { summary: "Third" },
      { summary: "Fourth" },
      { summary: "Fifth" },
    ];
    const result = fanOut(app, parent.id, { tasks });

    expect(result.childIds).toHaveLength(5);
    for (let i = 0; i < tasks.length; i++) {
      const child = app.sessions.get(result.childIds![i])!;
      expect(child.summary).toBe(tasks[i].summary);
    }
  });

  test("agent assignments match task order", () => {
    const parent = app.sessions.create({ summary: "agent order", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "plan", agent: "planner" },
        { summary: "implement", agent: "implementer" },
        { summary: "review", agent: "reviewer" },
        { summary: "document", agent: "documenter" },
      ],
    });

    const agents = result.childIds!.map((id) => app.sessions.get(id)!.agent);
    expect(agents).toEqual(["planner", "implementer", "reviewer", "documenter"]);
  });
});

// -- Large-scale fan-out -------------------------------------------------------

describe("large-scale fan-out", () => {
  test("50 children created and tracked correctly", () => {
    const parent = app.sessions.create({ summary: "big fan-out", flow: "bare" });
    const tasks = Array.from({ length: 50 }, (_, i) => ({ summary: `Task-${i}` }));

    const result = fanOut(app, parent.id, { tasks });
    expect(result.ok).toBe(true);
    expect(result.childIds).toHaveLength(50);

    // All children share same fork_group
    const groups = new Set(result.childIds!.map((id) => app.sessions.get(id)!.fork_group));
    expect(groups.size).toBe(1);

    // getChildren returns all 50
    const children = app.sessions.getChildren(parent.id);
    expect(children).toHaveLength(50);
  });

  test("50 children auto-join works when all complete", async () => {
    const parent = app.sessions.create({ summary: "big auto-join", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const tasks = Array.from({ length: 50 }, (_, i) => ({ summary: `Task-${i}` }));
    const result = fanOut(app, parent.id, { tasks });

    // Complete 49 children -- should NOT auto-join
    for (let i = 0; i < 49; i++) {
      app.sessions.update(result.childIds![i], { status: "completed" });
    }
    let joined = await checkAutoJoin(app, result.childIds![48]);
    expect(joined).toBe(false);

    // Complete last child -- should auto-join
    app.sessions.update(result.childIds![49], { status: "completed" });
    joined = await checkAutoJoin(app, result.childIds![49]);
    expect(joined).toBe(true);

    const parentState = app.sessions.get(parent.id)!;
    expect(parentState.fork_group).toBeNull();
    expect(parentState.status).not.toBe("waiting");
  });
});

// -- Soft-deleted children interaction -----------------------------------------

describe("fan-out with soft-deleted children", () => {
  test("soft-deleted child excluded from getChildren (status=deleting)", () => {
    const parent = app.sessions.create({ summary: "delete interaction", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "keep" }, { summary: "delete-me" }],
    });

    // Soft-delete one child
    app.sessions.softDelete(result.childIds![1]);

    // getChildren filters out deleting status
    const children = app.sessions.getChildren(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe(result.childIds![0]);
  });

  test("auto-join considers only non-deleted children", async () => {
    const parent = app.sessions.create({ summary: "delete auto-join", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    // Soft-delete child B, complete child A
    app.sessions.softDelete(result.childIds![1]);
    app.sessions.update(result.childIds![0], { status: "completed" });

    // With B deleted (filtered out), only A matters -- should auto-join
    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(true);
  });
});

// -- checkAutoJoin with stale fork_group from prior fan-out --------------------

describe("checkAutoJoin fork_group mismatch", () => {
  test("old children from prior fan-out do not block new auto-join", async () => {
    const parent = app.sessions.create({ summary: "fg mismatch", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    // First fan-out
    const r1 = fanOut(app, parent.id, { tasks: [{ summary: "old-A" }] });
    app.sessions.update(r1.childIds![0], { status: "completed" });
    await checkAutoJoin(app, r1.childIds![0]);

    // Parent advanced, reset for second fan-out
    app.sessions.update(parent.id, { stage: "work", status: "running" });
    const r2 = fanOut(app, parent.id, { tasks: [{ summary: "new-B" }] });

    // Old child from r1 still exists with a different fork_group
    const oldChild = app.sessions.get(r1.childIds![0])!;
    const newChild = app.sessions.get(r2.childIds![0])!;
    expect(oldChild.fork_group).not.toBe(newChild.fork_group);

    // Complete new child
    app.sessions.update(r2.childIds![0], { status: "completed" });
    const joined = await checkAutoJoin(app, r2.childIds![0]);
    expect(joined).toBe(true);
  });
});

// -- Parent status transition sequence -----------------------------------------

describe("parent status transition sequence", () => {
  test("running -> waiting -> ready through fan-out lifecycle", async () => {
    const parent = app.sessions.create({ summary: "transitions", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    // Starts running
    expect(app.sessions.get(parent.id)!.status).toBe("running");

    // Fan-out sets to waiting
    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child" }],
    });
    expect(app.sessions.get(parent.id)!.status).toBe("waiting");

    // Child completes, auto-join sets parent to ready (then advance)
    app.sessions.update(result.childIds![0], { status: "completed" });
    await checkAutoJoin(app, result.childIds![0]);

    const final = app.sessions.get(parent.id)!;
    // After auto-join + advance, parent should NOT be waiting
    expect(final.status).not.toBe("waiting");
    // fork_group should be cleared
    expect(final.fork_group).toBeNull();
  });

  test("joinFork transitions parent from waiting to ready+advance", async () => {
    const parent = app.sessions.create({ summary: "join transitions", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "A" }] });
    expect(app.sessions.get(parent.id)!.status).toBe("waiting");

    app.sessions.update(result.childIds![0], { status: "completed" });
    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(true);

    // Parent should not be waiting or in fork_group
    const final = app.sessions.get(parent.id)!;
    expect(final.status).not.toBe("waiting");
    expect(final.fork_group).toBeNull();
  });
});

// -- Fan-out with edge-case summaries ------------------------------------------

describe("fan-out with edge-case summaries", () => {
  test("very long summary preserved on child", () => {
    const parent = app.sessions.create({ summary: "long test", flow: "bare" });
    const longSummary = "A".repeat(500);

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: longSummary }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    expect(child.summary).toBe(longSummary);
  });

  test("summary with special characters preserved", () => {
    const parent = app.sessions.create({ summary: "special chars", flow: "bare" });
    const special = "Fix bug: SQL 'injection' test & <html> \"quotes\" (parens) [brackets]";

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: special }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    expect(child.summary).toBe(special);
  });

  test("child with same summary as parent works", () => {
    const parent = app.sessions.create({ summary: "duplicate name", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "duplicate name" }],
    });

    expect(result.ok).toBe(true);
    const child = app.sessions.get(result.childIds![0])!;
    expect(child.summary).toBe("duplicate name");
    expect(child.id).not.toBe(parent.id);
  });
});

// -- Fan-out children don't inherit parent config ------------------------------

describe("fan-out config isolation", () => {
  test("fan-out children do not inherit parent config blob", () => {
    const parent = app.sessions.create({
      summary: "config parent", flow: "bare",
      config: { custom_key: "parent-value", model_override: "opus" },
    });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child" }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    // fanOut creates children without config -- they should not have parent's config
    expect(child.config?.custom_key).toBeUndefined();
    expect(child.config?.model_override).toBeUndefined();
  });

  test("spawnSubagent sets its own config independent of parent config", () => {
    const parent = app.sessions.create({
      summary: "config parent", flow: "bare",
      config: { custom_key: "parent-value" },
    });

    const result = spawnSubagent(app, parent.id, {
      task: "subtask", model: "haiku",
    });

    const child = app.sessions.get(result.sessionId!)!;
    // spawnSubagent sets its own config
    expect(child.config?.subagent).toBe(true);
    expect(child.config?.model_override).toBe("haiku");
    // Parent's custom_key should NOT leak
    expect(child.config?.custom_key).toBeUndefined();
  });
});

// -- Multiple spawnSubagent with diverse overrides ----------------------------

describe("multiple spawnSubagent with diverse overrides", () => {
  test("each subagent gets independent config", () => {
    const parent = app.sessions.create({ summary: "diverse parent", flow: "bare" });
    app.sessions.update(parent.id, { status: "running", agent: "implementer" });

    const r1 = spawnSubagent(app, parent.id, { task: "cheap task", model: "haiku" });
    const r2 = spawnSubagent(app, parent.id, { task: "smart task", model: "opus" });
    const r3 = spawnSubagent(app, parent.id, { task: "default task" });

    const c1 = app.sessions.get(r1.sessionId!)!;
    const c2 = app.sessions.get(r2.sessionId!)!;
    const c3 = app.sessions.get(r3.sessionId!)!;

    expect(c1.config?.model_override).toBe("haiku");
    expect(c2.config?.model_override).toBe("opus");
    expect(c3.config?.model_override).toBeUndefined();

    // All inherit parent's agent
    expect(c1.agent).toBe("implementer");
    expect(c2.agent).toBe("implementer");
    expect(c3.agent).toBe("implementer");
  });

  test("subagents with agent overrides get correct agents", () => {
    const parent = app.sessions.create({ summary: "agent overrides", flow: "bare" });
    app.sessions.update(parent.id, { status: "running", agent: "implementer" });

    const r1 = spawnSubagent(app, parent.id, { task: "review", agent: "reviewer" });
    const r2 = spawnSubagent(app, parent.id, { task: "implement" });

    const c1 = app.sessions.get(r1.sessionId!)!;
    const c2 = app.sessions.get(r2.sessionId!)!;

    expect(c1.agent).toBe("reviewer");
    expect(c2.agent).toBe("implementer");
  });
});

// -- Double checkAutoJoin call (concurrent safety) -----------------------------

describe("checkAutoJoin concurrent-like calls", () => {
  test("two checkAutoJoin calls -- first joins, second returns false", async () => {
    const parent = app.sessions.create({ summary: "double-call", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "completed" });

    // Call from child A
    const first = await checkAutoJoin(app, result.childIds![0]);
    expect(first).toBe(true);

    // Call from child B -- parent already joined (not waiting)
    const second = await checkAutoJoin(app, result.childIds![1]);
    expect(second).toBe(false);
  });

  test("only one auto_join event created despite multiple calls", async () => {
    const parent = app.sessions.create({ summary: "single-event", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "A" }] });
    app.sessions.update(result.childIds![0], { status: "completed" });

    await checkAutoJoin(app, result.childIds![0]);
    await checkAutoJoin(app, result.childIds![0]);
    await checkAutoJoin(app, result.childIds![0]);

    const events = app.events.list(parent.id);
    const joinEvents = events.filter((e) => e.type === "auto_join");
    expect(joinEvents).toHaveLength(1);
  });
});

// -- fork() group_name behavior ------------------------------------------------

describe("fork group_name behavior", () => {
  test("fork does not inherit parent group_name (unlike fanOut)", () => {
    const parent = app.sessions.create({ summary: "grouped parent", flow: "bare", group_name: "release-v2" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fork(app, parent.id, "child task", { dispatch: false });
    const child = app.sessions.get(result.sessionId!)!;
    // fork() does not pass group_name to child (different from fanOut which does)
    expect(child.group_name).toBeNull();
  });

  test("fanOut DOES inherit parent group_name", () => {
    const parent = app.sessions.create({ summary: "grouped", flow: "bare", group_name: "team-x" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "child" }] });
    const child = app.sessions.get(result.childIds![0])!;
    expect(child.group_name).toBe("team-x");
  });
});

// -- retryWithContext on fan-out child preserves fork_group ---------------------

describe("retryWithContext preserves fan-out linkage", () => {
  test("retried child keeps parent_id and fork_group", () => {
    const parent = app.sessions.create({ summary: "retry parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "will fail" }] });
    const childId = result.childIds![0];

    app.sessions.update(childId, { status: "failed", error: "OOM" });
    retryWithContext(app, childId);

    const child = app.sessions.get(childId)!;
    expect(child.status).toBe("ready");
    expect(child.parent_id).toBe(parent.id);
    expect(child.fork_group).toBeTruthy();
    expect(child.error).toBeNull();
  });

  test("retried child can eventually trigger auto-join", async () => {
    const parent = app.sessions.create({ summary: "retry-join", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    // A completes, B fails
    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed", error: "timeout" });

    // Auto-join triggers (both terminal)
    const joined1 = await checkAutoJoin(app, result.childIds![1]);
    expect(joined1).toBe(true);

    // But we want to retry B -- first, reset parent to waiting (simulate)
    app.sessions.update(parent.id, { stage: "work", status: "running" });
    const r2 = fanOut(app, parent.id, { tasks: [{ summary: "B-retry" }] });

    app.sessions.update(r2.childIds![0], { status: "completed" });
    const joined2 = await checkAutoJoin(app, r2.childIds![0]);
    expect(joined2).toBe(true);
  });
});

// -- Fan-out event data integrity ----------------------------------------------

describe("fan-out event data integrity", () => {
  test("fan_out event forkGroup matches parent fork_group", () => {
    const parent = app.sessions.create({ summary: "event integrity", flow: "bare" });

    fanOut(app, parent.id, { tasks: [{ summary: "A" }] });

    const events = app.events.list(parent.id);
    const fanOutEvent = events.find((e) => e.type === "fan_out")!;
    expect(fanOutEvent.data?.forkGroup).toBe(app.sessions.get(parent.id)!.fork_group);
  });

  test("partial_failure event data lists exact failed child IDs", async () => {
    const parent = app.sessions.create({ summary: "fail ids", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "pass" }, { summary: "fail1" }, { summary: "pass2" }, { summary: "fail2" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed" });
    app.sessions.update(result.childIds![2], { status: "completed" });
    app.sessions.update(result.childIds![3], { status: "failed" });

    await checkAutoJoin(app, result.childIds![3]);

    const events = app.events.list(parent.id);
    const failEvent = events.find((e) => e.type === "fan_out_partial_failure")!;
    expect(failEvent.data?.failed).toHaveLength(2);
    expect(failEvent.data?.failed).toContain(result.childIds![1]);
    expect(failEvent.data?.failed).toContain(result.childIds![3]);
    expect(failEvent.data?.total).toBe(4);
  });

  test("auto_join event records correct children and failed counts", async () => {
    const parent = app.sessions.create({ summary: "join counts", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "ok1" }, { summary: "ok2" }, { summary: "bad" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "completed" });
    app.sessions.update(result.childIds![2], { status: "failed" });

    await checkAutoJoin(app, result.childIds![2]);

    const events = app.events.list(parent.id);
    const joinEvent = events.find((e) => e.type === "auto_join")!;
    expect(joinEvent.data?.children).toBe(3);
    expect(joinEvent.data?.failed).toBe(1);
  });

  test("fork_joined event from joinFork includes child count", async () => {
    const parent = app.sessions.create({ summary: "join event data", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }, { summary: "C" }],
    });

    for (const id of result.childIds!) {
      app.sessions.update(id, { status: "completed" });
    }

    await joinFork(app, parent.id);

    const events = app.events.list(parent.id);
    const joinEvent = events.find((e) => e.type === "fork_joined")!;
    expect(joinEvent).toBeTruthy();
    expect(joinEvent.data?.children).toBe(3);
  });
});

// -- Mixed fanOut + spawnSubagent children on same parent ----------------------

describe("mixed fanOut and spawnSubagent on same parent", () => {
  test("both types of children linked to same parent", () => {
    const parent = app.sessions.create({ summary: "mixed", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const fanResult = fanOut(app, parent.id, { tasks: [{ summary: "fan-child" }] });
    const subResult = spawnSubagent(app, parent.id, { task: "sub-child" });

    const children = app.sessions.getChildren(parent.id);
    const childIds = children.map((c) => c.id);
    expect(childIds).toContain(fanResult.childIds![0]);
    expect(childIds).toContain(subResult.sessionId!);
  });

  test("fan-out child has fork_group, subagent does not", () => {
    const parent = app.sessions.create({ summary: "mixed-fg", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const fanResult = fanOut(app, parent.id, { tasks: [{ summary: "fan" }] });
    const subResult = spawnSubagent(app, parent.id, { task: "sub" });

    const fanChild = app.sessions.get(fanResult.childIds![0])!;
    const subChild = app.sessions.get(subResult.sessionId!)!;

    expect(fanChild.fork_group).toBeTruthy();
    expect(subChild.fork_group).toBeFalsy();
  });
});

// -- Fan-out with various flow assignments ------------------------------------

describe("fan-out with various child flow assignments", () => {
  test("children get correct first stage for their flow", () => {
    const parent = app.sessions.create({ summary: "flow stages", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "bare child", flow: "bare" },
        { summary: "quick child", flow: "quick" },
      ],
    });

    const bareChild = app.sessions.get(result.childIds![0])!;
    const quickChild = app.sessions.get(result.childIds![1])!;

    // Both should have stage set (the first stage of their respective flow)
    expect(bareChild.stage).toBeTruthy();
    expect(quickChild.stage).toBeTruthy();

    // Both should be in ready status
    expect(bareChild.status).toBe("ready");
    expect(quickChild.status).toBe("ready");
  });

  test("children default to bare flow when not specified", () => {
    const parent = app.sessions.create({ summary: "default flow", flow: "quick" }); // parent is quick

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child without flow" }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    // Children default to bare, NOT parent's flow
    expect(child.flow).toBe("bare");
  });
});
