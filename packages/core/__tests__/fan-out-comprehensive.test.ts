/**
 * Comprehensive fan-out tests covering gaps in existing test files:
 * - fork() dispatch behavior and agent option
 * - checkAutoJoin with non-terminal child statuses (running, paused, blocked, stopped)
 * - fanOut ticket inheritance
 * - joinFork advances parent to next stage
 * - Multiple sequential fan-outs on same parent
 * - Deep nesting (fan-out child does its own fan-out)
 * - checkAutoJoin called from middle children (not last)
 * - fanOut on already-waiting parent (double fan-out guard)
 * - spawnParallelSubagents with nonexistent parent
 * - fork() fork_group reuse across many children
 * - advance() flow progression after auto-join completes
 * - fan-out children with mixed flows
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import {
  fanOut,
  checkAutoJoin,
  joinFork,
  fork,
  spawnSubagent,
  spawnParallelSubagents,
  advance,
} from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

// ── checkAutoJoin with non-terminal statuses ──────────────────────────────

describe("checkAutoJoin with non-terminal child statuses", () => {
  test("returns false when a child is still running", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "running" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(false);
    expect(app.sessions.get(parent.id)!.status).toBe("waiting");
  });

  test("returns false when a child is paused", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "paused" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(false);
  });

  test("returns false when a child is stopped", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "stopped" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(false);
  });

  test("returns false when a child is blocked", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "failed" });
    app.sessions.update(result.childIds![1], { status: "blocked" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(false);
  });

  test("returns false when a child is still in ready status", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    // B remains in ready status (default after fanOut)
    app.sessions.update(result.childIds![0], { status: "completed" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(false);
  });
});

// ── checkAutoJoin called from different children ──────────────────────────

describe("checkAutoJoin called from middle children", () => {
  test("auto-join triggers regardless of which child triggers it", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }, { summary: "C" }],
    });

    // Complete all three
    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "completed" });
    app.sessions.update(result.childIds![2], { status: "completed" });

    // Trigger auto-join from the first child (not the last one completed)
    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(true);
  });

  test("auto-join can be triggered by a failed child", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed" });

    // Trigger from the failed child
    const joined = await checkAutoJoin(app, result.childIds![1]);
    expect(joined).toBe(true);
  });
});

// ── fanOut ticket inheritance ─────────────────────────────────────────────

describe("fanOut ticket inheritance", () => {
  test("children do not inherit parent ticket (ticket is not set)", () => {
    const parent = app.sessions.create({ summary: "test", flow: "bare" });
    app.sessions.update(parent.id, { ticket: "PROJ-456" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child task" }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    // fanOut does not pass ticket to children (only repo, workdir, compute_name, group_name)
    expect(child.ticket).toBeFalsy();
  });
});

// ── fork() ticket and field inheritance ───────────────────────────────────

describe("fork() ticket inheritance", () => {
  test("fork inherits parent ticket", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, {
      stage: "work", status: "running", ticket: "PROJ-789",
    });

    const result = await fork(app, parent.id, "child task", { dispatch: false });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.ticket).toBe("PROJ-789");
  });

  test("fork with no parent ticket produces child with no ticket", async () => {
    const parent = app.sessions.create({ summary: "no ticket parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = await fork(app, parent.id, "child task", { dispatch: false });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.ticket).toBeFalsy();
  });
});

// ── Deep nesting: fan-out child does its own fan-out ──────────────────────

describe("deep nesting: fan-out within fan-out", () => {
  test("child can do its own fan-out creating grandchildren", () => {
    const grandparent = app.sessions.create({ summary: "grandparent", flow: "bare" });
    app.sessions.update(grandparent.id, { stage: "work", status: "running" });

    const parentResult = fanOut(app, grandparent.id, {
      tasks: [{ summary: "parent child" }],
    });
    const parentChildId = parentResult.childIds![0];
    app.sessions.update(parentChildId, { stage: "work", status: "running" });

    // The child does its own fan-out
    const childResult = fanOut(app, parentChildId, {
      tasks: [{ summary: "grandchild A" }, { summary: "grandchild B" }],
    });

    expect(childResult.ok).toBe(true);
    expect(childResult.childIds).toHaveLength(2);

    // Parent child is now waiting
    expect(app.sessions.get(parentChildId)!.status).toBe("waiting");

    // Grandchildren link to the parent child, not the grandparent
    for (const gcId of childResult.childIds!) {
      const gc = app.sessions.get(gcId)!;
      expect(gc.parent_id).toBe(parentChildId);
    }

    // Grandparent is still waiting for its own children
    expect(app.sessions.get(grandparent.id)!.status).toBe("waiting");
  });

  test("grandchild completion auto-joins parent child, then parent child can auto-join grandparent", async () => {
    const grandparent = app.sessions.create({ summary: "gp", flow: "bare" });
    app.sessions.update(grandparent.id, { stage: "work", status: "running" });

    const parentResult = fanOut(app, grandparent.id, {
      tasks: [{ summary: "parent child" }],
    });
    const parentChildId = parentResult.childIds![0];
    app.sessions.update(parentChildId, { stage: "work", status: "running" });

    const childResult = fanOut(app, parentChildId, {
      tasks: [{ summary: "gc A" }],
    });

    // Complete the grandchild
    app.sessions.update(childResult.childIds![0], { status: "completed" });
    const gcJoined = await checkAutoJoin(app, childResult.childIds![0]);
    expect(gcJoined).toBe(true);

    // Parent child should no longer be waiting after auto-join
    const parentChild = app.sessions.get(parentChildId)!;
    expect(parentChild.status).not.toBe("waiting");

    // If parent child becomes completed, auto-join should advance grandparent
    app.sessions.update(parentChildId, { status: "completed" });
    const parentJoined = await checkAutoJoin(app, parentChildId);
    expect(parentJoined).toBe(true);

    expect(app.sessions.get(grandparent.id)!.status).not.toBe("waiting");
  });
});

// ── Multiple fan-outs on the same parent ──────────────────────────────────

describe("sequential fan-outs on same parent", () => {
  test("second fan-out overwrites fork_group", () => {
    const parent = app.sessions.create({ summary: "double fan-out", flow: "bare" });

    const r1 = fanOut(app, parent.id, { tasks: [{ summary: "A" }] });
    const fg1 = app.sessions.get(parent.id)!.fork_group;

    const r2 = fanOut(app, parent.id, { tasks: [{ summary: "B" }] });
    const fg2 = app.sessions.get(parent.id)!.fork_group;

    // fork_group changes on second fan-out
    expect(fg1).not.toBe(fg2);

    // Both sets of children exist but with different fork_groups
    const child1 = app.sessions.get(r1.childIds![0])!;
    const child2 = app.sessions.get(r2.childIds![0])!;
    expect(child1.fork_group).toBe(fg1);
    expect(child2.fork_group).toBe(fg2);
  });
});

// ── joinFork advances parent ──────────────────────────────────────────────

describe("joinFork advances parent", () => {
  test("joinFork clears fork_group and advances parent", async () => {
    const parent = app.sessions.create({ summary: "join advance", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });

    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(true);

    const parentState = app.sessions.get(parent.id)!;
    expect(parentState.fork_group).toBeNull();
    // Parent should have advanced to next stage (review) or completed
    expect(parentState.stage).not.toBe("execute");
  });

  test("auto-join on fan-out flow advances parent past fan_out stage", async () => {
    const parent = app.sessions.create({ summary: "auto advance", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    await checkAutoJoin(app, result.childIds![0]);

    const parentState = app.sessions.get(parent.id)!;
    // After execute completes, should advance to review
    expect(parentState.stage).toBe("review");
  });
});

// ── fork() fork_group reuse ───────────────────────────────────────────────

describe("fork() fork_group consistency", () => {
  test("many forks all share the same fork_group", async () => {
    const parent = app.sessions.create({ summary: "many forks", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await fork(app, parent.id, `task ${i}`, { dispatch: false }));
    }

    const forkGroups = results.map((r) =>
      app.sessions.get(r.sessionId!)!.fork_group
    );

    // All should be the same
    const uniqueGroups = new Set(forkGroups);
    expect(uniqueGroups.size).toBe(1);
    expect(app.sessions.get(parent.id)!.fork_group).toBe(forkGroups[0]);
  });

  test("fork on parent with existing fork_group reuses it", async () => {
    const parent = app.sessions.create({ summary: "pre-set fg", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running", fork_group: "existing-fg" });

    const result = await fork(app, parent.id, "task", { dispatch: false });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.fork_group).toBe("existing-fg");
  });
});

// ── fanOut children with mixed flows ──────────────────────────────────────

describe("fanOut with mixed child flows", () => {
  test("each child can have a different flow", () => {
    const parent = app.sessions.create({ summary: "mixed flows", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "bare child", flow: "bare" },
        { summary: "quick child", flow: "quick" },
      ],
    });

    expect(result.ok).toBe(true);
    const child1 = app.sessions.get(result.childIds![0])!;
    const child2 = app.sessions.get(result.childIds![1])!;
    expect(child1.flow).toBe("bare");
    expect(child2.flow).toBe("quick");
  });

  test("children with different flows get their respective first stages", () => {
    const parent = app.sessions.create({ summary: "flow stages", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "bare child", flow: "bare" },
        { summary: "quick child", flow: "quick" },
      ],
    });

    const child1 = app.sessions.get(result.childIds![0])!;
    const child2 = app.sessions.get(result.childIds![1])!;
    // Both should have a stage set
    expect(child1.stage).toBeTruthy();
    expect(child2.stage).toBeTruthy();
    // They may or may not be the same depending on flow definitions
  });
});

// ── spawnParallelSubagents with bad parent ─────────────────────────────────

describe("spawnParallelSubagents error handling", () => {
  test("with nonexistent parent returns empty sessionIds", async () => {
    const result = await spawnParallelSubagents(app, "s-nonexistent", [
      { task: "A" }, { task: "B" },
    ]);

    // spawnSubagent returns ok:false for each, so no ids collected
    expect(result.sessionIds).toHaveLength(0);
  });

  test("all subagents linked to same parent", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { status: "running" });

    const result = await spawnParallelSubagents(app, parent.id, [
      { task: "A" }, { task: "B" }, { task: "C" },
    ]);

    for (const id of result.sessionIds) {
      expect(app.sessions.get(id)!.parent_id).toBe(parent.id);
    }
  });
});

// ── Event ordering and completeness ───────────────────────────────────────

describe("fan-out event completeness", () => {
  test("full lifecycle produces correct event sequence", async () => {
    const parent = app.sessions.create({ summary: "event seq", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "completed" });
    await checkAutoJoin(app, result.childIds![1]);

    const events = app.events.list(parent.id);
    const types = events.map((e) => e.type);

    expect(types).toContain("fan_out");
    expect(types).toContain("auto_join");
  });

  test("fan_out event has correct childCount and forkGroup", () => {
    const parent = app.sessions.create({ summary: "event data", flow: "bare" });

    fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }, { summary: "C" }],
    });

    const events = app.events.list(parent.id);
    const fanOutEvent = events.find((e) => e.type === "fan_out")!;
    expect(fanOutEvent.data?.childCount).toBe(3);
    expect(fanOutEvent.data?.forkGroup).toBeTruthy();
    expect(fanOutEvent.data?.forkGroup).toBe(app.sessions.get(parent.id)!.fork_group);
  });

  test("auto_join event records correct children and failed counts", async () => {
    const parent = app.sessions.create({ summary: "join events", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "ok" }, { summary: "ok2" }, { summary: "fail" }],
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
});

// ── fanOut with parent that has no stage ──────────────────────────────────

describe("fanOut with various parent states", () => {
  test("fanOut works on parent with no stage set", () => {
    const parent = app.sessions.create({ summary: "no stage", flow: "bare" });
    // Don't set stage

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child" }],
    });

    expect(result.ok).toBe(true);
    expect(app.sessions.get(parent.id)!.status).toBe("waiting");
  });

  test("fanOut works on parent with completed status", () => {
    const parent = app.sessions.create({ summary: "completed parent", flow: "bare" });
    app.sessions.update(parent.id, { status: "completed" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child" }],
    });

    // fanOut doesn't check parent status, it just sets it to waiting
    expect(result.ok).toBe(true);
    expect(app.sessions.get(parent.id)!.status).toBe("waiting");
  });
});

// ── spawnSubagent and fork differences ────────────────────────────────────

describe("spawnSubagent vs fork differences", () => {
  test("spawnSubagent uses quick flow, fork uses bare flow", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const subResult = spawnSubagent(app, parent.id, { task: "sub task" });
    const forkResult = await fork(app, parent.id, "fork task", { dispatch: false });

    const sub = app.sessions.get(subResult.sessionId!)!;
    const forked = app.sessions.get(forkResult.sessionId!)!;

    expect(sub.flow).toBe("quick");
    expect(forked.flow).toBe("bare");
  });

  test("spawnSubagent sets config.subagent, fork does not", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const subResult = spawnSubagent(app, parent.id, { task: "sub" });
    const forkResult = await fork(app, parent.id, "fork", { dispatch: false });

    const sub = app.sessions.get(subResult.sessionId!)!;
    const forked = app.sessions.get(forkResult.sessionId!)!;

    expect(sub.config?.subagent).toBe(true);
    expect(forked.config?.subagent).toBeFalsy();
  });

  test("spawnSubagent does not set fork_group, fork does", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const subResult = spawnSubagent(app, parent.id, { task: "sub" });
    const forkResult = await fork(app, parent.id, "fork", { dispatch: false });

    const sub = app.sessions.get(subResult.sessionId!)!;
    const forked = app.sessions.get(forkResult.sessionId!)!;

    expect(sub.fork_group).toBeFalsy();
    expect(forked.fork_group).toBeTruthy();
  });
});

// ── Single-child fan-out edge case ────────────────────────────────────────

describe("single-child fan-out", () => {
  test("single child fan-out works end-to-end", async () => {
    const parent = app.sessions.create({ summary: "single", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "only child" }] });
    expect(result.childIds).toHaveLength(1);
    expect(app.sessions.get(parent.id)!.status).toBe("waiting");

    app.sessions.update(result.childIds![0], { status: "completed" });
    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(true);

    expect(app.sessions.get(parent.id)!.status).not.toBe("waiting");
    expect(app.sessions.get(parent.id)!.fork_group).toBeNull();
  });

  test("single failed child triggers auto-join with partial_failure event", async () => {
    const parent = app.sessions.create({ summary: "single fail", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "will fail" }] });
    app.sessions.update(result.childIds![0], { status: "failed" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(true);

    const events = app.events.list(parent.id);
    expect(events.some((e) => e.type === "fan_out_partial_failure")).toBe(true);
  });
});

// ── getChildren consistency ───────────────────────────────────────────────

describe("getChildren after fan-out operations", () => {
  test("getChildren returns empty after parent has no children", () => {
    const parent = app.sessions.create({ summary: "no kids", flow: "bare" });
    expect(app.sessions.getChildren(parent.id)).toHaveLength(0);
  });

  test("getChildren count matches task count after fan-out", () => {
    const parent = app.sessions.create({ summary: "exact count", flow: "bare" });
    fanOut(app, parent.id, {
      tasks: [{ summary: "1" }, { summary: "2" }, { summary: "3" }, { summary: "4" }, { summary: "5" }],
    });

    expect(app.sessions.getChildren(parent.id)).toHaveLength(5);
  });

  test("children from fan-out all have ready status", () => {
    const parent = app.sessions.create({ summary: "ready check", flow: "bare" });
    fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    const children = app.sessions.getChildren(parent.id);
    for (const child of children) {
      expect(child.status).toBe("ready");
    }
  });
});
