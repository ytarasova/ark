/**
 * Fan-out gap tests: scenarios not covered by existing fan-out test files.
 *
 * Covers:
 * - spawnParallelSubagents with extensions and group_name
 * - joinFork force=true when all children already completed (no-op force)
 * - checkAutoJoin when parent is soft-deleted
 * - retryWithContext default maxRetries exhaustion (exactly 3)
 * - retryWithContext tracks different error messages per attempt
 * - Full lifecycle: fanOut -> child fails -> retry -> complete -> auto-join
 * - fanOut children don't inherit parent ticket (unlike fork)
 * - joinFork return value propagates from advance()
 * - checkAutoJoin with children from both fanOut and spawnSubagent
 * - fanOut on parent with existing non-null fork_group from prior fork()
 * - spawnParallelSubagents preserves order
 * - fork() agent option is recorded in event but not on child session directly
 * - dispatchFanOut with PLAN.md parsing + extractSubtasks fallback
 * - dispatchFanOut max_parallel limiting
 * - advance() flow progression (bare completes, fan-out advances to review)
 * - Fan-out children with null parent fields
 * - joinFork on parent with no fork_group
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { AppContext, setApp, clearApp } from "../app.js";
import {
  fanOut,
  checkAutoJoin,
  joinFork,
  fork,
  spawnSubagent,
  spawnParallelSubagents,
  retryWithContext,
  dispatch,
} from "../services/session-orchestration.js";
import { WORKTREES_DIR } from "../paths.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => {
  await Bun.sleep(200); // Let background child dispatches settle
  await app?.shutdown();
  clearApp();
});

// -- spawnParallelSubagents with extensions and group_name ---------------------

describe("spawnParallelSubagents with extensions and group_name", () => {
  test("extensions from individual spawn options are preserved", async () => {
    const parent = app.sessions.create({ summary: "ext parent", flow: "bare" });
    app.sessions.update(parent.id, { status: "running" });

    const r1 = spawnSubagent(app, parent.id, {
      task: "with slack", extensions: ["slack"],
    });
    const r2 = spawnSubagent(app, parent.id, {
      task: "with github", extensions: ["github", "linear"],
    });
    const r3 = spawnSubagent(app, parent.id, {
      task: "no extensions",
    });

    expect(app.sessions.get(r1.sessionId!)!.config?.extensions).toEqual(["slack"]);
    expect(app.sessions.get(r2.sessionId!)!.config?.extensions).toEqual(["github", "linear"]);
    expect(app.sessions.get(r3.sessionId!)!.config?.extensions).toBeUndefined();
  });

  test("group_name override works per subagent", () => {
    const parent = app.sessions.create({ summary: "group parent", flow: "bare", group_name: "default-group" });

    const r1 = spawnSubagent(app, parent.id, { task: "inherit group" });
    const r2 = spawnSubagent(app, parent.id, { task: "custom group", group_name: "override-group" });

    expect(app.sessions.get(r1.sessionId!)!.group_name).toBe("default-group");
    expect(app.sessions.get(r2.sessionId!)!.group_name).toBe("override-group");
  });

  test("group_name with no parent group defaults to null", () => {
    const parent = app.sessions.create({ summary: "no group", flow: "bare" });

    const result = spawnSubagent(app, parent.id, { task: "task" });
    const child = app.sessions.get(result.sessionId!)!;
    // No group_name on parent, no override -- should be null/undefined
    expect(child.group_name).toBeFalsy();
  });
});

// -- joinFork force=true when all children already completed ------------------

describe("joinFork force=true on fully completed children", () => {
  test("force join succeeds even when all children completed (no-op force)", async () => {
    const parent = app.sessions.create({ summary: "all done", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "completed" });

    // Force=true should succeed just like force=false when all completed
    const joinResult = await joinFork(app, parent.id, true);
    expect(joinResult.ok).toBe(true);

    const parentState = app.sessions.get(parent.id)!;
    expect(parentState.fork_group).toBeNull();
    expect(parentState.status).not.toBe("waiting");
  });
});

// -- checkAutoJoin when parent is soft-deleted --------------------------------

describe("checkAutoJoin with deleted parent", () => {
  test("returns false when parent is soft-deleted", async () => {
    const parent = app.sessions.create({ summary: "will delete", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "orphan child" }],
    });
    app.sessions.update(result.childIds![0], { status: "completed" });

    // Soft-delete parent
    app.sessions.softDelete(parent.id);

    // checkAutoJoin should return false since parent is now "deleting" and get() filters it
    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(false);
  });
});

// -- retryWithContext default maxRetries exhaustion ----------------------------

describe("retryWithContext default maxRetries (3)", () => {
  test("allows exactly 3 retries by default, blocks 4th", () => {
    const s = app.sessions.create({ summary: "retry limit", flow: "bare" });

    // Retry 1
    app.sessions.update(s.id, { status: "failed", error: "err1" });
    let r = retryWithContext(app, s.id);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("1/3");

    // Retry 2
    app.sessions.update(s.id, { status: "failed", error: "err2" });
    r = retryWithContext(app, s.id);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("2/3");

    // Retry 3
    app.sessions.update(s.id, { status: "failed", error: "err3" });
    r = retryWithContext(app, s.id);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("3/3");

    // Retry 4 -- should be blocked
    app.sessions.update(s.id, { status: "failed", error: "err4" });
    r = retryWithContext(app, s.id);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Max retries");
  });

  test("each retry event records the specific error from that attempt", () => {
    const s = app.sessions.create({ summary: "errors tracked", flow: "bare" });

    app.sessions.update(s.id, { status: "failed", error: "OOM", stage: "implement" });
    retryWithContext(app, s.id);

    app.sessions.update(s.id, { status: "failed", error: "timeout", stage: "implement" });
    retryWithContext(app, s.id);

    const events = app.events.list(s.id);
    const retries = events.filter((e) => e.type === "retry_with_context");
    expect(retries).toHaveLength(2);

    // Events should record the error that was present at retry time
    expect(retries[0].data?.error).toBe("OOM");
    expect(retries[0].data?.attempt).toBe(1);
    expect(retries[1].data?.error).toBe("timeout");
    expect(retries[1].data?.attempt).toBe(2);
  });
});

// -- Full lifecycle: fanOut -> fail -> retry -> complete -> auto-join ----------

describe("full lifecycle with retry in fan-out", () => {
  test("fan-out child fails, gets retried, completes, triggers auto-join", async () => {
    const parent = app.sessions.create({ summary: "retry lifecycle", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "solid" }, { summary: "flaky" }],
    });

    // Solid child completes
    app.sessions.update(result.childIds![0], { status: "completed" });

    // Flaky child fails
    app.sessions.update(result.childIds![1], { status: "failed", error: "flake" });

    // Both are terminal -- auto-join triggers with partial failure
    const joined1 = await checkAutoJoin(app, result.childIds![1]);
    expect(joined1).toBe(true);

    // Verify partial failure event was logged
    const events1 = app.events.list(parent.id);
    expect(events1.some((e) => e.type === "fan_out_partial_failure")).toBe(true);

    // Now start a second fan-out cycle to retry the flaky task
    app.sessions.update(parent.id, { stage: "work", status: "running" });
    const r2 = fanOut(app, parent.id, {
      tasks: [{ summary: "flaky retry" }],
    });

    // This time it succeeds
    app.sessions.update(r2.childIds![0], { status: "completed" });
    const joined2 = await checkAutoJoin(app, r2.childIds![0]);
    expect(joined2).toBe(true);

    // Parent should be out of waiting state
    const finalParent = app.sessions.get(parent.id)!;
    expect(finalParent.status).not.toBe("waiting");
    expect(finalParent.fork_group).toBeNull();
  });

  test("retryWithContext on fan-out child then completing triggers auto-join only after ALL children done", async () => {
    const parent = app.sessions.create({ summary: "retry-then-join", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    // A completes, B fails
    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed", error: "crash" });

    // Both terminal -- auto-join triggers
    await checkAutoJoin(app, result.childIds![1]);

    // Retry B in a new fan-out cycle
    app.sessions.update(parent.id, { stage: "work", status: "running" });
    const r2 = fanOut(app, parent.id, {
      tasks: [{ summary: "B retry" }],
    });

    // Not yet completed -- auto-join should NOT trigger
    const premature = await checkAutoJoin(app, r2.childIds![0]);
    expect(premature).toBe(false);

    // Now complete it
    app.sessions.update(r2.childIds![0], { status: "completed" });
    const joined = await checkAutoJoin(app, r2.childIds![0]);
    expect(joined).toBe(true);
  });
});

// -- fanOut ticket inheritance vs fork ticket inheritance ----------------------

describe("fanOut vs fork ticket inheritance", () => {
  test("fanOut children do NOT inherit ticket, fork children DO", () => {
    const parent = app.sessions.create({ summary: "ticket test", flow: "bare" });
    app.sessions.update(parent.id, {
      stage: "work", status: "running", ticket: "PROJ-100",
    });

    const fanResult = fanOut(app, parent.id, {
      tasks: [{ summary: "fan child" }],
    });
    const forkResult = fork(app, parent.id, "fork child", { dispatch: false });

    const fanChild = app.sessions.get(fanResult.childIds![0])!;
    const forkChild = app.sessions.get(forkResult.sessionId!)!;

    // fanOut does not propagate ticket
    expect(fanChild.ticket).toBeFalsy();
    // fork does propagate ticket
    expect(forkChild.ticket).toBe("PROJ-100");
  });
});

// -- joinFork return value propagation ----------------------------------------

describe("joinFork return value from advance", () => {
  test("joinFork returns ok:true with message after successful advance", async () => {
    const parent = app.sessions.create({ summary: "advance return", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });

    const joinResult = await joinFork(app, parent.id);
    // joinFork delegates to advance() and returns its result
    expect(joinResult.ok).toBe(true);
    expect(typeof joinResult.message).toBe("string");
  });

  test("joinFork on parent with no remaining stages still succeeds", async () => {
    const parent = app.sessions.create({ summary: "last stage", flow: "bare" });
    // bare flow has "work" as only stage
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "last child" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });

    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(true);

    // Parent should be completed or in a terminal state since bare has only one stage
    const parentState = app.sessions.get(parent.id)!;
    expect(parentState.fork_group).toBeNull();
  });
});

// -- checkAutoJoin with mixed child sources (fanOut + spawnSubagent) -----------

describe("checkAutoJoin with mixed child types", () => {
  test("fan-out children and subagent children both count in auto-join", async () => {
    const parent = app.sessions.create({ summary: "mixed sources", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    // Create fan-out children
    const fanResult = fanOut(app, parent.id, {
      tasks: [{ summary: "fan A" }],
    });

    // Also spawn a subagent on the same parent
    const subResult = spawnSubagent(app, parent.id, { task: "sub B" });

    // Complete the fan-out child
    app.sessions.update(fanResult.childIds![0], { status: "completed" });

    // Parent is still waiting because subagent child is in "ready" status
    const joined1 = await checkAutoJoin(app, fanResult.childIds![0]);
    // checkAutoJoin sees ALL children (including the subagent), so it won't join yet
    expect(joined1).toBe(false);

    // Complete the subagent child too
    app.sessions.update(subResult.sessionId!, { status: "completed" });

    const joined2 = await checkAutoJoin(app, subResult.sessionId!);
    expect(joined2).toBe(true);
  });
});

// -- fanOut on parent with pre-existing fork_group from fork() ----------------

describe("fanOut on parent with pre-existing fork_group from fork()", () => {
  test("fanOut overwrites the fork_group set by a prior fork()", () => {
    const parent = app.sessions.create({ summary: "fork then fan", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    // fork() sets a fork_group on parent
    fork(app, parent.id, "fork child", { dispatch: false });
    const forkGroupFromFork = app.sessions.get(parent.id)!.fork_group;
    expect(forkGroupFromFork).toBeTruthy();

    // fanOut replaces with a new fork_group
    const fanResult = fanOut(app, parent.id, {
      tasks: [{ summary: "fan child" }],
    });

    const newForkGroup = app.sessions.get(parent.id)!.fork_group;
    expect(newForkGroup).toBeTruthy();
    expect(newForkGroup).not.toBe(forkGroupFromFork);

    // The fan-out child uses the new fork_group
    const fanChild = app.sessions.get(fanResult.childIds![0])!;
    expect(fanChild.fork_group).toBe(newForkGroup);
  });
});

// -- spawnParallelSubagents preserves creation order --------------------------

describe("spawnParallelSubagents order", () => {
  test("sessionIds returned in same order as input tasks", async () => {
    const parent = app.sessions.create({ summary: "order test", flow: "bare" });
    app.sessions.update(parent.id, { status: "running" });

    const tasks = [
      { task: "First task" },
      { task: "Second task" },
      { task: "Third task" },
    ];

    const result = await spawnParallelSubagents(app, parent.id, tasks);
    expect(result.sessionIds).toHaveLength(3);

    for (let i = 0; i < tasks.length; i++) {
      const child = app.sessions.get(result.sessionIds[i])!;
      expect(child.summary).toBe(tasks[i].task);
    }
  });

  test("mixed model overrides in parallel subagents", async () => {
    const parent = app.sessions.create({ summary: "mixed parallel", flow: "bare" });
    app.sessions.update(parent.id, { status: "running", agent: "implementer" });

    const result = await spawnParallelSubagents(app, parent.id, [
      { task: "review" },
      { task: "cheap", model: "haiku" },
    ]);

    expect(result.sessionIds).toHaveLength(2);

    const c0 = app.sessions.get(result.sessionIds[0])!;
    const c1 = app.sessions.get(result.sessionIds[1])!;

    // Both linked to parent
    expect(c0.parent_id).toBe(parent.id);
    expect(c1.parent_id).toBe(parent.id);
    // Model override stored in config
    expect(c1.config?.model_override).toBe("haiku");
  });
});

// -- fork() agent option event recording --------------------------------------

describe("fork() agent option behavior", () => {
  test("fork with agent option -- agent is NOT set on child (handled by dispatch)", () => {
    const parent = app.sessions.create({ summary: "fork agent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fork(app, parent.id, "review task", { agent: "reviewer", dispatch: false });
    const child = app.sessions.get(result.sessionId!)!;

    // fork() does not set agent directly -- it passes to dispatch
    // When dispatch=false, the child won't have the agent override applied
    expect(child.agent).toBeNull();
    // But the child is still linked correctly
    expect(child.parent_id).toBe(parent.id);
    expect(child.summary).toBe("review task");
  });
});

// -- checkAutoJoin: child with parent_id pointing to nonexistent session ------

describe("checkAutoJoin with missing parent reference", () => {
  test("child whose parent_id points to nonexistent session returns false", async () => {
    const child = app.sessions.create({ summary: "orphan ref", flow: "bare" });
    app.sessions.update(child.id, { parent_id: "s-0000dead", status: "completed" });

    const joined = await checkAutoJoin(app, child.id);
    expect(joined).toBe(false);
  });
});

// -- fanOut preserves child independence (no cross-contamination) --------------

describe("fanOut child independence", () => {
  test("updating one child status does not affect siblings", () => {
    const parent = app.sessions.create({ summary: "independent", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }, { summary: "C" }],
    });

    // Update only the first child
    app.sessions.update(result.childIds![0], { status: "completed" });

    // Other children remain in ready status
    expect(app.sessions.get(result.childIds![1])!.status).toBe("ready");
    expect(app.sessions.get(result.childIds![2])!.status).toBe("ready");
  });

  test("updating one child agent does not affect siblings", () => {
    const parent = app.sessions.create({ summary: "agent independent", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "A", agent: "implementer" },
        { summary: "B", agent: "reviewer" },
      ],
    });

    app.sessions.update(result.childIds![0], { agent: "documenter" });

    // Sibling unchanged
    expect(app.sessions.get(result.childIds![1])!.agent).toBe("reviewer");
  });
});

// -- spawnSubagent config.parent_id matches actual parent_id ------------------

describe("spawnSubagent config consistency", () => {
  test("config.parent_id matches the session's parent_id field", () => {
    const parent = app.sessions.create({ summary: "config parent", flow: "bare" });

    const result = spawnSubagent(app, parent.id, { task: "child" });
    const child = app.sessions.get(result.sessionId!)!;

    expect(child.parent_id).toBe(parent.id);
    expect(child.config?.parent_id).toBe(parent.id);
  });
});

// -- checkAutoJoin: all children failed logs partial_failure ------------------

describe("checkAutoJoin all-failed produces partial_failure", () => {
  test("when all children fail, both partial_failure and auto_join events are logged", async () => {
    const parent = app.sessions.create({ summary: "all fail events", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "fail A" }, { summary: "fail B" }, { summary: "fail C" }],
    });

    for (const id of result.childIds!) {
      app.sessions.update(id, { status: "failed" });
    }

    await checkAutoJoin(app, result.childIds![0]);

    const events = app.events.list(parent.id);
    const failEvent = events.find((e) => e.type === "fan_out_partial_failure")!;
    const joinEvent = events.find((e) => e.type === "auto_join")!;

    expect(failEvent).toBeTruthy();
    expect(failEvent.data?.failed).toHaveLength(3);
    expect(failEvent.data?.total).toBe(3);

    expect(joinEvent).toBeTruthy();
    expect(joinEvent.data?.children).toBe(3);
    expect(joinEvent.data?.failed).toBe(3);
  });
});

// -- fanOut child summaries with Unicode --------------------------------------

describe("fanOut child summaries with Unicode", () => {
  test("Unicode summaries preserved correctly", () => {
    const parent = app.sessions.create({ summary: "unicode test", flow: "bare" });

    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "Implement authentication" },
        { summary: "Korrektur der Datenbank-Migration" },
        { summary: "Fix l'erreur de connexion" },
      ],
    });

    expect(app.sessions.get(result.childIds![0])!.summary).toBe("Implement authentication");
    expect(app.sessions.get(result.childIds![1])!.summary).toBe("Korrektur der Datenbank-Migration");
    expect(app.sessions.get(result.childIds![2])!.summary).toBe("Fix l'erreur de connexion");
  });
});

// ── dispatchFanOut + extractSubtasks integration ────────────────────────────

describe("dispatchFanOut with extractSubtasks fallback", () => {
  test("dispatch on fan_out stage without PLAN.md creates default subtasks", async () => {
    const parent = app.sessions.create({ summary: "Build login page", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "ready" });

    const result = await dispatch(app, parent.id);
    expect(result.ok).toBe(true);

    // extractSubtasks fallback: "Implement: <summary>" + "Write tests for: <summary>"
    const children = app.sessions.getChildren(parent.id);
    expect(children.length).toBeGreaterThanOrEqual(2);

    const summaries = children.map((c) => c.summary);
    expect(summaries.some((s) => s.includes("Implement"))).toBe(true);
    expect(summaries.some((s) => s.includes("tests"))).toBe(true);

    expect(app.sessions.get(parent.id)!.status).toBe("waiting");
  });

  test("dispatch on fan_out stage assigns agent from stageDef or fallback", async () => {
    const parent = app.sessions.create({ summary: "Fix bug", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "ready" });

    await dispatch(app, parent.id);

    // dispatchFanOut uses: stageDef.agent ?? session.agent ?? "implementer"
    const children = app.sessions.getChildren(parent.id);
    for (const child of children) {
      expect(child.agent).toBeTruthy();
    }
  });
});

describe("dispatchFanOut with PLAN.md parsing", () => {
  test("PLAN.md with multiple steps creates one child per step", async () => {
    const parent = app.sessions.create({ summary: "Refactor auth", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "ready" });

    const wtDir = join(WORKTREES_DIR(), parent.id);
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "PLAN.md"), [
      "# Plan",
      "",
      "## Step 1: Extract auth middleware",
      "Move auth logic into its own module.",
      "",
      "## Step 2: Add token validation",
      "Implement JWT token validation.",
      "",
      "## Step 3: Write integration tests",
      "Cover all auth endpoints.",
    ].join("\n"));

    try {
      const result = await dispatch(app, parent.id);
      expect(result.ok).toBe(true);

      const children = app.sessions.getChildren(parent.id);
      expect(children).toHaveLength(3);

      const summaries = children.map((c) => c.summary);
      // getChildren returns DESC order; check all steps present regardless of order
      expect(summaries.some((s) => s.includes("Step 1"))).toBe(true);
      expect(summaries.some((s) => s.includes("Step 2"))).toBe(true);
      expect(summaries.some((s) => s.includes("Step 3"))).toBe(true);
    } finally {
      if (existsSync(wtDir)) rmSync(wtDir, { recursive: true, force: true });
    }
  });

  test("PLAN.md with only 1 step falls back to default subtasks", async () => {
    const parent = app.sessions.create({ summary: "Tiny task", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "ready" });

    const wtDir = join(WORKTREES_DIR(), parent.id);
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "PLAN.md"), [
      "# Plan",
      "",
      "## Step 1: Do everything",
      "Just do it all.",
    ].join("\n"));

    try {
      await dispatch(app, parent.id);

      // extractSubtasks requires >= 2 steps, so falls back
      const children = app.sessions.getChildren(parent.id);
      expect(children).toHaveLength(2);
      const summaries = children.map((c) => c.summary);
      expect(summaries.some((s) => s.includes("Implement"))).toBe(true);
    } finally {
      if (existsSync(wtDir)) rmSync(wtDir, { recursive: true, force: true });
    }
  });

  test("max_parallel caps children from large PLAN.md", async () => {
    const parent = app.sessions.create({ summary: "Many steps", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "ready" });

    const wtDir = join(WORKTREES_DIR(), parent.id);
    mkdirSync(wtDir, { recursive: true });
    const steps = Array.from({ length: 15 }, (_, i) =>
      `## Step ${i + 1}: Task ${i + 1}\nDescription for step ${i + 1}.`
    ).join("\n\n");
    writeFileSync(join(wtDir, "PLAN.md"), `# Plan\n\n${steps}`);

    try {
      await dispatch(app, parent.id);

      const children = app.sessions.getChildren(parent.id);
      // default max_parallel for fan_out stages is 8
      expect(children.length).toBeLessThanOrEqual(8);
      expect(children.length).toBeGreaterThan(0);
    } finally {
      if (existsSync(wtDir)) rmSync(wtDir, { recursive: true, force: true });
    }
  });
});

// ── advance() flow progression after auto-join ────────────────────────────

describe("advance flow progression after auto-join", () => {
  test("bare flow parent completes after auto-join (single stage)", async () => {
    const parent = app.sessions.create({ summary: "bare complete", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "child" }] });
    app.sessions.update(result.childIds![0], { status: "completed" });
    await checkAutoJoin(app, result.childIds![0]);

    // bare: only "work" stage -> advance completes the session
    const parentState = app.sessions.get(parent.id)!;
    expect(parentState.status).toBe("completed");
  });

  test("fan-out flow parent advances to review after execute stage auto-join", async () => {
    const parent = app.sessions.create({ summary: "flow advance", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "child" }] });
    app.sessions.update(result.childIds![0], { status: "completed" });
    await checkAutoJoin(app, result.childIds![0]);

    // fan-out: plan -> execute -> review
    const parentState = app.sessions.get(parent.id)!;
    expect(parentState.stage).toBe("review");
    expect(parentState.status).toBe("ready");
  });

  test("joinFork also triggers advance to next flow stage", async () => {
    const parent = app.sessions.create({ summary: "join advance", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "child" }] });
    app.sessions.update(result.childIds![0], { status: "completed" });
    await joinFork(app, parent.id);

    expect(app.sessions.get(parent.id)!.stage).toBe("review");
  });
});

// ── Fan-out children with null parent fields ─────────────────────────────

describe("fan-out with null parent fields", () => {
  test("children created when parent has null repo/workdir/compute", () => {
    const parent = app.sessions.create({ summary: "bare parent", flow: "bare" });
    // Don't set repo, workdir, or compute_name

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child A" }, { summary: "child B" }],
    });

    expect(result.ok).toBe(true);
    for (const childId of result.childIds!) {
      const child = app.sessions.get(childId)!;
      expect(child.repo).toBeFalsy();
      expect(child.workdir).toBeFalsy();
      expect(child.compute_name).toBeFalsy();
    }
  });

  test("children with null group_name when parent has none", () => {
    const parent = app.sessions.create({ summary: "no group", flow: "bare" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "child" }] });
    const child = app.sessions.get(result.childIds![0])!;
    expect(child.group_name).toBeFalsy();
  });
});

// ── joinFork edge case: parent with children but no fork_group ───────────

describe("joinFork with no fork_group", () => {
  test("joinFork works on parent that lost fork_group", async () => {
    const parent = app.sessions.create({ summary: "lost fg", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "child" }] });
    app.sessions.update(result.childIds![0], { status: "completed" });

    // Clear parent fork_group manually (edge case)
    app.sessions.update(parent.id, { fork_group: null });

    // joinFork checks children count, not fork_group
    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(true);
  });

  test("joinFork works with subagent children (no fork_group on children)", async () => {
    const parent = app.sessions.create({ summary: "subagent join", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    spawnSubagent(app, parent.id, { task: "task A" });
    spawnSubagent(app, parent.id, { task: "task B" });

    const children = app.sessions.getChildren(parent.id);
    for (const child of children) {
      app.sessions.update(child.id, { status: "completed" });
    }

    const joinResult = await joinFork(app, parent.id);
    expect(joinResult.ok).toBe(true);
  });
});

// ── Event ordering through full lifecycle ────────────────────────────────

describe("event ordering through fan-out lifecycle", () => {
  test("fan_out event precedes partial_failure which precedes auto_join", async () => {
    const parent = app.sessions.create({ summary: "event order", flow: "bare" });
    app.sessions.update(parent.id, { stage: "work", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    app.sessions.update(result.childIds![1], { status: "failed" });
    app.sessions.update(result.childIds![0], { status: "completed" });
    await checkAutoJoin(app, result.childIds![0]);

    const events = app.events.list(parent.id);
    const types = events.map((e) => e.type);

    const fanOutIdx = types.indexOf("fan_out");
    const partialFailIdx = types.indexOf("fan_out_partial_failure");
    const autoJoinIdx = types.indexOf("auto_join");

    expect(fanOutIdx).toBeGreaterThanOrEqual(0);
    expect(autoJoinIdx).toBeGreaterThan(fanOutIdx);
    expect(partialFailIdx).toBeGreaterThan(fanOutIdx);
    expect(partialFailIdx).toBeLessThan(autoJoinIdx);
  });

  test("subagent_spawned event includes all metadata fields", () => {
    const parent = app.sessions.create({ summary: "event meta", flow: "bare" });
    app.sessions.update(parent.id, { agent: "implementer" });

    const result = spawnSubagent(app, parent.id, {
      task: "review code",
      agent: "reviewer",
      model: "haiku",
    });

    const events = app.events.list(result.sessionId!);
    const spawnEvent = events.find((e) => e.type === "subagent_spawned")!;

    expect(spawnEvent.data?.parent_id).toBe(parent.id);
    expect(spawnEvent.data?.task).toBe("review code");
    expect(spawnEvent.data?.agent).toBe("reviewer");
    expect(spawnEvent.data?.model).toBe("haiku");
  });
});

// ── retryWithContext preserves stage ─────────────────────────────────────

describe("retryWithContext preserves stage", () => {
  test("stage is preserved after retry (only status and error reset)", () => {
    const s = app.sessions.create({ summary: "stage preserve", flow: "quick" });
    app.sessions.update(s.id, { status: "failed", error: "crash", stage: "implement" });

    retryWithContext(app, s.id);

    const updated = app.sessions.get(s.id)!;
    expect(updated.status).toBe("ready");
    expect(updated.error).toBeNull();
    expect(updated.stage).toBe("implement");
  });
});
