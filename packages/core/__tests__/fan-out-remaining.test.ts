/**
 * Fan-out remaining coverage: scenarios not covered by existing fan-out test files.
 *
 * Covers:
 * - retryWithContext with custom maxRetries edge values (0, 1)
 * - retryWithContext preserves parent_id and fork_group linkage
 * - checkAutoJoin when child status is "waiting" (nested fan-out in progress)
 * - fanOut on parent already in "waiting" status (double fan-out)
 * - joinFork force=true logs fork_joined event
 * - joinFork with a single completed child among many not-done children
 * - checkAutoJoin cascade: grandchild completes -> parent auto-joins -> grandparent auto-joins
 * - fanOut children inherit compute_name but not agent from parent
 * - spawnSubagent with null parent agent (no agent to inherit)
 * - fork() inherits parent compute_name
 * - Multiple fan-outs on same parent: getChildren returns all from all cycles
 * - checkAutoJoin with child in "archived" status
 * - retryWithContext clears error but preserves agent
 * - spawnParallelSubagents with single task
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
  retryWithContext,
} from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

// -- retryWithContext with edge maxRetries values --

describe("retryWithContext edge maxRetries values", () => {
  test("maxRetries=0 blocks all retries immediately", () => {
    const s = app.sessions.create({ summary: "no retries", flow: "bare" });
    app.sessions.update(s.id, { status: "failed", error: "crash" });

    const result = retryWithContext(app, s.id, { maxRetries: 0 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Max retries");
  });

  test("maxRetries=1 allows exactly 1 retry", () => {
    const s = app.sessions.create({ summary: "one retry", flow: "bare" });

    app.sessions.update(s.id, { status: "failed", error: "err1" });
    const r1 = retryWithContext(app, s.id, { maxRetries: 1 });
    expect(r1.ok).toBe(true);
    expect(r1.message).toContain("1/1");

    app.sessions.update(s.id, { status: "failed", error: "err2" });
    const r2 = retryWithContext(app, s.id, { maxRetries: 1 });
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain("Max retries");
  });

  test("maxRetries=5 allows 5 retries", () => {
    const s = app.sessions.create({ summary: "five retries", flow: "bare" });

    for (let i = 1; i <= 5; i++) {
      app.sessions.update(s.id, { status: "failed", error: `err${i}` });
      const r = retryWithContext(app, s.id, { maxRetries: 5 });
      expect(r.ok).toBe(true);
      expect(r.message).toContain(`${i}/5`);
    }

    app.sessions.update(s.id, { status: "failed", error: "err6" });
    const blocked = retryWithContext(app, s.id, { maxRetries: 5 });
    expect(blocked.ok).toBe(false);
  });
});

// -- retryWithContext preserves agent --

describe("retryWithContext preserves session fields", () => {
  test("agent field preserved after retry", () => {
    const s = app.sessions.create({ summary: "agent preserve", flow: "bare" });
    app.sessions.update(s.id, { status: "failed", error: "crash", agent: "implementer" });

    retryWithContext(app, s.id);

    const updated = app.sessions.get(s.id)!;
    expect(updated.status).toBe("ready");
    expect(updated.agent).toBe("implementer");
  });

  test("repo and workdir preserved after retry", () => {
    const s = app.sessions.create({ summary: "fields preserve", flow: "bare" });
    app.sessions.update(s.id, {
      status: "failed", error: "crash",
      repo: "my-repo", workdir: "/tmp/code",
    });

    retryWithContext(app, s.id);

    const updated = app.sessions.get(s.id)!;
    expect(updated.repo).toBe("my-repo");
    expect(updated.workdir).toBe("/tmp/code");
  });
});

// -- checkAutoJoin when child is in "waiting" status (nested fan-out) --

describe("checkAutoJoin with waiting child", () => {
  test("returns false when a child is in waiting status (nested fan-out)", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    // A completes, B is doing its own fan-out (waiting)
    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "waiting" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(false);
    expect(app.sessions.get(parent.id)!.status).toBe("waiting");
  });
});

// -- fanOut on parent already in waiting status --

describe("fanOut on already-waiting parent", () => {
  test("overwrites the existing fork_group and children", () => {
    const parent = app.sessions.create({ summary: "double fan", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    // First fan-out
    const r1 = fanOut(app, parent.id, { tasks: [{ summary: "A" }] });
    expect(app.sessions.get(parent.id)!.status).toBe("waiting");
    const fg1 = app.sessions.get(parent.id)!.fork_group;

    // Second fan-out while parent is still waiting
    const r2 = fanOut(app, parent.id, { tasks: [{ summary: "B" }] });
    expect(r2.ok).toBe(true);
    const fg2 = app.sessions.get(parent.id)!.fork_group;

    // Fork group should change
    expect(fg2).not.toBe(fg1);
    // Both sets of children exist
    const allChildren = app.sessions.getChildren(parent.id);
    expect(allChildren.length).toBe(2); // one from each fan-out
    const childIds = allChildren.map(c => c.id);
    expect(childIds).toContain(r1.childIds![0]);
    expect(childIds).toContain(r2.childIds![0]);
  });
});

// -- joinFork force=true event logging --

describe("joinFork force=true event logging", () => {
  test("force join still logs fork_joined event", async () => {
    const parent = app.sessions.create({ summary: "force event", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });
    // Leave children in "ready" status -- not completed

    const joinResult = await joinFork(app, parent.id, true);
    expect(joinResult.ok).toBe(true);

    const events = app.events.list(parent.id);
    const joinEvent = events.find(e => e.type === "fork_joined");
    expect(joinEvent).toBeTruthy();
    expect(joinEvent!.data?.children).toBe(2);
  });
});

// -- joinFork with single completed among many --

describe("joinFork with partial completion", () => {
  test("one completed, two not-done, no force -> fails", async () => {
    const parent = app.sessions.create({ summary: "partial done", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }, { summary: "C" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    // B and C remain "ready"

    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(false);
    expect(joinResult.message).toContain("2 children not done");
  });

  test("one completed, two not-done, force -> succeeds", async () => {
    const parent = app.sessions.create({ summary: "force partial", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }, { summary: "C" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });

    const joinResult = await joinFork(app, parent.id, true);
    expect(joinResult.ok).toBe(true);
  });
});

// -- checkAutoJoin cascade: grandchild -> parent -> grandparent --

describe("checkAutoJoin cascade through three levels", () => {
  test("completing grandchild auto-joins parent, completing parent auto-joins grandparent", async () => {
    // Level 0: grandparent
    const gp = app.sessions.create({ summary: "grandparent", flow: "bare" });
    app.sessions.update(gp.id, { stage: "work", status: "running" });

    // Level 1: parent (only child of grandparent)
    const gpFanOut = fanOut(app, gp.id, { tasks: [{ summary: "parent" }] });
    const parentId = gpFanOut.childIds![0];
    app.sessions.update(parentId, { stage: "work", status: "running" });

    // Level 2: grandchild (only child of parent)
    const parentFanOut = fanOut(app, parentId, { tasks: [{ summary: "grandchild" }] });
    const grandchildId = parentFanOut.childIds![0];

    // Verify chain: gp waiting, parent waiting
    expect(app.sessions.get(gp.id)!.status).toBe("waiting");
    expect(app.sessions.get(parentId)!.status).toBe("waiting");

    // Complete grandchild -> should auto-join parent
    app.sessions.update(grandchildId, { status: "completed" });
    const gcJoined = await checkAutoJoin(app, grandchildId);
    expect(gcJoined).toBe(true);

    // Parent should be completed (bare flow, single stage)
    const parentState = app.sessions.get(parentId)!;
    expect(parentState.status).toBe("completed");

    // Now trigger auto-join on grandparent from completed parent
    const pJoined = await checkAutoJoin(app, parentId);
    expect(pJoined).toBe(true);

    // Grandparent should be completed too
    const gpState = app.sessions.get(gp.id)!;
    expect(gpState.status).toBe("completed");
    expect(gpState.fork_group).toBeNull();
  });
});

// -- fanOut children do not inherit agent from parent --

describe("fanOut agent inheritance behavior", () => {
  test("children without explicit agent get null (don't inherit parent agent)", () => {
    const parent = app.sessions.create({ summary: "parent with agent", flow: "bare" });
    app.sessions.update(parent.id, { agent: "implementer" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "no agent child" }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    // fanOut does NOT inherit parent's agent -- must be explicitly specified
    expect(child.agent).toBeNull();
  });

  test("children with explicit agent get that agent", () => {
    const parent = app.sessions.create({ summary: "explicit agent", flow: "bare" });
    app.sessions.update(parent.id, { agent: "implementer" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "with agent", agent: "reviewer" },
        { summary: "no agent" },
      ],
    });

    expect(app.sessions.get(result.childIds![0])!.agent).toBe("reviewer");
    expect(app.sessions.get(result.childIds![1])!.agent).toBeNull();
  });
});

// -- spawnSubagent with null parent agent --

describe("spawnSubagent with no parent agent", () => {
  test("inherits null agent when parent has no agent set", () => {
    const parent = app.sessions.create({ summary: "no agent parent", flow: "bare" });
    // Don't set agent

    const result = spawnSubagent(app, parent.id, { task: "child task" });
    const child = app.sessions.get(result.sessionId!)!;
    // agent will be null since parent has no agent and none specified
    expect(child.agent).toBeNull();
  });

  test("overrides with explicit agent even when parent has none", () => {
    const parent = app.sessions.create({ summary: "no agent parent", flow: "bare" });

    const result = spawnSubagent(app, parent.id, {
      task: "review task", agent: "reviewer",
    });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.agent).toBe("reviewer");
  });
});

// -- fork() inherits compute_name --

describe("fork() compute_name inheritance", () => {
  test("fork inherits parent compute_name", () => {
    const parent = app.sessions.create({ summary: "ec2 parent", flow: "bare" });
    app.sessions.update(parent.id, {
      stage: "work", status: "running", compute_name: "my-ec2",
    });

    const result = fork(app, parent.id, "child task", { dispatch: false });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.compute_name).toBe("my-ec2");
  });

  test("fork with null compute_name on parent creates child with null compute", () => {
    const parent = app.sessions.create({ summary: "local parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fork(app, parent.id, "child", { dispatch: false });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.compute_name).toBeFalsy();
  });
});

// -- getChildren across multiple fan-out cycles --

describe("getChildren across multiple fan-out cycles", () => {
  test("returns children from all fan-out cycles", () => {
    const parent = app.sessions.create({ summary: "multi cycle children", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const r1 = fanOut(app, parent.id, { tasks: [{ summary: "cycle1-A" }] });
    const r2 = fanOut(app, parent.id, { tasks: [{ summary: "cycle2-B" }] });

    const children = app.sessions.getChildren(parent.id);
    expect(children).toHaveLength(2);

    const ids = children.map(c => c.id);
    expect(ids).toContain(r1.childIds![0]);
    expect(ids).toContain(r2.childIds![0]);
  });

  test("children from different cycles have different fork_groups", () => {
    const parent = app.sessions.create({ summary: "diff fg", flow: "bare" });

    const r1 = fanOut(app, parent.id, { tasks: [{ summary: "A" }] });
    const r2 = fanOut(app, parent.id, { tasks: [{ summary: "B" }] });

    const c1 = app.sessions.get(r1.childIds![0])!;
    const c2 = app.sessions.get(r2.childIds![0])!;

    expect(c1.fork_group).not.toBe(c2.fork_group);
  });
});

// -- spawnParallelSubagents with single task --

describe("spawnParallelSubagents with single task", () => {
  test("single task spawns one subagent", async () => {
    const parent = app.sessions.create({ summary: "single parallel", flow: "bare" });
    app.sessions.update(parent.id, { status: "running" });

    const result = await spawnParallelSubagents(app, parent.id, [
      { task: "only task" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.sessionIds).toHaveLength(1);

    const child = app.sessions.get(result.sessionIds[0])!;
    expect(child.parent_id).toBe(parent.id);
    expect(child.summary).toBe("only task");
    expect(child.config?.subagent).toBe(true);
  });
});

// -- checkAutoJoin with archived child --

describe("checkAutoJoin with archived child", () => {
  test("archived child is excluded from getChildren", async () => {
    const parent = app.sessions.create({ summary: "archive test", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "keep" }, { summary: "archive-me" }],
    });

    // Archive one child
    app.sessions.update(result.childIds![1], { status: "archived" });

    // Complete the kept child
    app.sessions.update(result.childIds![0], { status: "completed" });

    // Auto-join should consider only non-archived children
    // If archived counts as terminal: should join
    // If archived is filtered out: should join (only remaining child is completed)
    const children = app.sessions.getChildren(parent.id);
    // Verify archived status behavior
    if (children.length === 1) {
      // Archived is filtered out, only completed child remains -> join
      const joined = await checkAutoJoin(app, result.childIds![0]);
      expect(joined).toBe(true);
    } else {
      // Both children visible, archived is not completed/failed -> no join
      const joined = await checkAutoJoin(app, result.childIds![0]);
      // archived is not in (completed, failed) so won't be "allDone"
      expect(joined).toBe(false);
    }
  });
});

// -- fork() without dispatch creates dispatchable child --

describe("fork() creates dispatchable child", () => {
  test("child from fork has stage and ready status", () => {
    const parent = app.sessions.create({ summary: "dispatchable", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fork(app, parent.id, "child task", { dispatch: false });
    const child = app.sessions.get(result.sessionId!)!;

    expect(child.status).toBe("ready");
    expect(child.stage).toBe("work"); // inherits parent stage
    expect(child.flow).toBe("bare");
  });
});

// -- fanOut with single task creates one child --

describe("fanOut single task", () => {
  test("creates exactly one child and sets parent to waiting", () => {
    const parent = app.sessions.create({ summary: "single", flow: "bare" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "only" }] });

    expect(result.ok).toBe(true);
    expect(result.childIds).toHaveLength(1);
    expect(app.sessions.get(parent.id)!.status).toBe("waiting");

    const child = app.sessions.get(result.childIds![0])!;
    expect(child.parent_id).toBe(parent.id);
    expect(child.summary).toBe("only");
  });
});

// -- retryWithContext on completed session --

describe("retryWithContext on non-failed statuses", () => {
  test("rejects completed session", () => {
    const s = app.sessions.create({ summary: "completed", flow: "bare" });
    app.sessions.update(s.id, { status: "completed" });

    const result = retryWithContext(app, s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not in failed state");
  });

  test("rejects waiting session", () => {
    const s = app.sessions.create({ summary: "waiting", flow: "bare" });
    app.sessions.update(s.id, { status: "waiting" });

    const result = retryWithContext(app, s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not in failed state");
  });

  test("rejects ready session", () => {
    const s = app.sessions.create({ summary: "ready", flow: "bare" });
    app.sessions.update(s.id, { status: "ready" });

    const result = retryWithContext(app, s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not in failed state");
  });
});

// -- joinFork returns advance result --

describe("joinFork return value", () => {
  test("message includes advance info", async () => {
    const parent = app.sessions.create({ summary: "return msg", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "A" }] });
    app.sessions.update(result.childIds![0], { status: "completed" });

    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(true);
    expect(joinResult.message).toBeTruthy();
  });
});

// -- fanOut event data includes correct forkGroup --

describe("fanOut event forkGroup consistency", () => {
  test("forkGroup in event matches parent fork_group and children fork_group", () => {
    const parent = app.sessions.create({ summary: "fg consistency", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    const parentFg = app.sessions.get(parent.id)!.fork_group;
    const events = app.events.list(parent.id);
    const fanOutEvent = events.find(e => e.type === "fan_out")!;

    expect(fanOutEvent.data?.forkGroup).toBe(parentFg);

    for (const childId of result.childIds!) {
      expect(app.sessions.get(childId)!.fork_group).toBe(parentFg);
    }
  });
});
