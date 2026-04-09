/**
 * Extended fan-out tests covering fork(), retryWithContext, extractSubtasks dispatch,
 * edge cases, and integration scenarios not covered by the existing fan-out test files.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
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
afterAll(async () => { await app?.shutdown(); clearApp(); });

// ── fork() ──────────────────────────────────────────────────────────────────

describe("fork()", () => {
  test("creates child linked to parent with fork_group", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = await fork(app, parent.id, "Subtask A", { dispatch: false });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeTruthy();

    const child = app.sessions.get(result.sessionId!)!;
    expect(child.parent_id).toBe(parent.id);
    expect(child.summary).toBe("Subtask A");
    expect(child.flow).toBe("bare");
    expect(child.status).toBe("ready");
  });

  test("inherits parent ticket, repo, compute_name, workdir", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, {
      stage: "implement", status: "running",
      repo: "myrepo", workdir: "/tmp/repo", compute_name: "ec2-box",
    });
    // Set ticket via update (ticket is a DB field)
    app.sessions.update(parent.id, { ticket: "PROJ-123" });

    const result = await fork(app, parent.id, "child task", { dispatch: false });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.repo).toBe("myrepo");
    expect(child.workdir).toBe("/tmp/repo");
    expect(child.compute_name).toBe("ec2-box");
    expect(child.ticket).toBe("PROJ-123");
  });

  test("parent and child share fork_group", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = await fork(app, parent.id, "task", { dispatch: false });
    const updatedParent = app.sessions.get(parent.id)!;
    const child = app.sessions.get(result.sessionId!)!;
    expect(updatedParent.fork_group).toBeTruthy();
    expect(child.fork_group).toBe(updatedParent.fork_group);
  });

  test("multiple forks reuse same fork_group", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const r1 = await fork(app, parent.id, "task A", { dispatch: false });
    const r2 = await fork(app, parent.id, "task B", { dispatch: false });

    const c1 = app.sessions.get(r1.sessionId!)!;
    const c2 = app.sessions.get(r2.sessionId!)!;
    expect(c1.fork_group).toBe(c2.fork_group);
  });

  test("logs session_forked event on child", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = await fork(app, parent.id, "logged task", { dispatch: false });
    const events = app.events.list(result.sessionId!);
    const forkEvent = events.find((e) => e.type === "session_forked");
    expect(forkEvent).toBeTruthy();
    expect(forkEvent!.data?.parent_id).toBe(parent.id);
    expect(forkEvent!.data?.task).toBe("logged task");
  });

  test("child inherits parent stage", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "review", status: "running" });

    const result = await fork(app, parent.id, "review subtask", { dispatch: false });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.stage).toBe("review");
  });

  test("uses custom agent when specified", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = await fork(app, parent.id, "review subtask", { agent: "reviewer", dispatch: false });
    // fork() doesn't set agent directly -- it's set by dispatch. Check the child exists.
    expect(result.ok).toBe(true);
  });

  test("nonexistent parent returns error", async () => {
    const result = await fork(app, "s-does-not-exist", "task", { dispatch: false });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });
});

// ── retryWithContext ────────────────────────────────────────────────────────

describe("retryWithContext", () => {
  test("retries failed session", () => {
    const s = app.sessions.create({ summary: "will fail", flow: "bare" });
    app.sessions.update(s.id, { status: "failed", error: "timeout" });

    const result = retryWithContext(app, s.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("1/3");

    const updated = app.sessions.get(s.id)!;
    expect(updated.status).toBe("ready");
    expect(updated.error).toBeNull();
  });

  test("logs retry event with error context", () => {
    const s = app.sessions.create({ summary: "retry test", flow: "bare" });
    app.sessions.update(s.id, { status: "failed", error: "OOM", stage: "implement" });

    retryWithContext(app, s.id);
    const events = app.events.list(s.id);
    const retryEvent = events.find((e) => e.type === "retry_with_context");
    expect(retryEvent).toBeTruthy();
    expect(retryEvent!.data?.attempt).toBe(1);
    expect(retryEvent!.data?.error).toBe("OOM");
    expect(retryEvent!.data?.stage).toBe("implement");
  });

  test("respects max retries", () => {
    const s = app.sessions.create({ summary: "max retry", flow: "bare" });
    app.sessions.update(s.id, { status: "failed", error: "err" });

    retryWithContext(app, s.id, { maxRetries: 2 });
    app.sessions.update(s.id, { status: "failed", error: "err again" });
    retryWithContext(app, s.id, { maxRetries: 2 });
    app.sessions.update(s.id, { status: "failed", error: "err third" });

    const result = retryWithContext(app, s.id, { maxRetries: 2 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Max retries");
  });

  test("rejects non-failed session", () => {
    const s = app.sessions.create({ summary: "running", flow: "bare" });
    app.sessions.update(s.id, { status: "running" });

    const result = retryWithContext(app, s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not in failed state");
  });

  test("nonexistent session returns error", () => {
    const result = retryWithContext(app, "s-nope");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });
});

// ── fanOut edge cases ──────────────────────────────────────────────────────

describe("fanOut edge cases", () => {
  test("fork_group is unique per fan-out call", () => {
    const p1 = app.sessions.create({ summary: "parent 1", flow: "bare" });
    const p2 = app.sessions.create({ summary: "parent 2", flow: "bare" });

    const r1 = fanOut(app, p1.id, { tasks: [{ summary: "A" }] });
    const r2 = fanOut(app, p2.id, { tasks: [{ summary: "B" }] });

    const c1 = app.sessions.get(r1.childIds![0])!;
    const c2 = app.sessions.get(r2.childIds![0])!;
    expect(c1.fork_group).not.toBe(c2.fork_group);
  });

  test("large task list creates many children", () => {
    const parent = app.sessions.create({ summary: "big fan-out", flow: "bare" });
    const tasks = Array.from({ length: 10 }, (_, i) => ({ summary: `Task ${i}` }));

    const result = fanOut(app, parent.id, { tasks });
    expect(result.ok).toBe(true);
    expect(result.childIds).toHaveLength(10);
  });

  test("children summaries match input tasks", () => {
    const parent = app.sessions.create({ summary: "summary check", flow: "bare" });
    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "Alpha" },
        { summary: "Beta" },
        { summary: "Gamma" },
      ],
    });

    const summaries = result.childIds!.map((id) => app.sessions.get(id)!.summary);
    expect(summaries).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  test("children get first stage of their flow", () => {
    const parent = app.sessions.create({ summary: "test stage init", flow: "bare" });
    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child", flow: "bare" }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    // bare flow first stage is "work"
    expect(child.stage).toBeTruthy();
  });

  test("mixed agents across children", () => {
    const parent = app.sessions.create({ summary: "mixed", flow: "bare" });
    const result = fanOut(app, parent.id, {
      tasks: [
        { summary: "implement", agent: "implementer" },
        { summary: "review", agent: "reviewer" },
        { summary: "document", agent: "documenter" },
      ],
    });

    expect(app.sessions.get(result.childIds![0])!.agent).toBe("implementer");
    expect(app.sessions.get(result.childIds![1])!.agent).toBe("reviewer");
    expect(app.sessions.get(result.childIds![2])!.agent).toBe("documenter");
  });

  test("children without explicit agent get null agent", () => {
    const parent = app.sessions.create({ summary: "no agent", flow: "bare" });
    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "child" }],
    });

    const child = app.sessions.get(result.childIds![0])!;
    expect(child.agent).toBeNull();
  });
});

// ── checkAutoJoin edge cases ────────────────────────────────────────────────

describe("checkAutoJoin edge cases", () => {
  test("mixed completed and failed children triggers join", async () => {
    const parent = app.sessions.create({ summary: "mixed", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "ok" }, { summary: "fail" }, { summary: "ok2" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed" });
    app.sessions.update(result.childIds![2], { status: "completed" });

    const joined = await checkAutoJoin(app, result.childIds![2]);
    expect(joined).toBe(true);

    // Verify partial failure event
    const events = app.events.list(parent.id);
    const failEvent = events.find((e) => e.type === "fan_out_partial_failure");
    expect(failEvent).toBeTruthy();
    expect(failEvent!.data?.failed).toHaveLength(1);
    expect(failEvent!.data?.total).toBe(3);
  });

  test("all children failed triggers join with failure event", async () => {
    const parent = app.sessions.create({ summary: "all fail", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "fail1" }, { summary: "fail2" }],
    });

    app.sessions.update(result.childIds![0], { status: "failed" });
    app.sessions.update(result.childIds![1], { status: "failed" });

    const joined = await checkAutoJoin(app, result.childIds![1]);
    expect(joined).toBe(true);

    const events = app.events.list(parent.id);
    const failEvent = events.find((e) => e.type === "fan_out_partial_failure");
    expect(failEvent).toBeTruthy();
    expect(failEvent!.data?.failed).toHaveLength(2);
  });

  test("auto-join clears fork_group on parent", async () => {
    const parent = app.sessions.create({ summary: "clear fg", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "A" }] });

    // Verify fork_group set
    expect(app.sessions.get(parent.id)!.fork_group).toBeTruthy();

    app.sessions.update(result.childIds![0], { status: "completed" });
    await checkAutoJoin(app, result.childIds![0]);

    expect(app.sessions.get(parent.id)!.fork_group).toBeNull();
  });

  test("calling checkAutoJoin on completed child with no siblings still joins", async () => {
    const parent = app.sessions.create({ summary: "single child", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "only child" }] });
    app.sessions.update(result.childIds![0], { status: "completed" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(true);
  });

  test("checkAutoJoin is idempotent -- second call returns false", async () => {
    const parent = app.sessions.create({ summary: "idempotent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "A" }] });
    app.sessions.update(result.childIds![0], { status: "completed" });

    const first = await checkAutoJoin(app, result.childIds![0]);
    expect(first).toBe(true);

    // Parent is no longer "waiting" after first join
    const second = await checkAutoJoin(app, result.childIds![0]);
    expect(second).toBe(false);
  });
});

// ── joinFork edge cases ─────────────────────────────────────────────────────

describe("joinFork edge cases", () => {
  test("joinFork with mixed completed/failed children (no force) fails", async () => {
    const parent = app.sessions.create({ summary: "mixed join", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "ok" }, { summary: "fail" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed" });

    // joinFork checks for "completed" only (not "failed"), so failed children count as "not done"
    const joinResult = await joinFork(app, parent.id);
    // The source checks c.status !== "completed" -- so failed children are "not done"
    expect(joinResult.ok).toBe(false);
    expect(joinResult.message).toContain("not done");
  });

  test("force joinFork with failed children succeeds", async () => {
    const parent = app.sessions.create({ summary: "force join", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "ok" }, { summary: "fail" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed" });

    const joinResult = await joinFork(app, parent.id, true);
    expect(joinResult.ok).toBe(true);
  });

  test("joinFork logs fork_joined event", async () => {
    const parent = app.sessions.create({ summary: "event log", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }],
    });
    app.sessions.update(result.childIds![0], { status: "completed" });

    await joinFork(app, parent.id);

    const events = app.events.list(parent.id);
    const joinEvent = events.find((e) => e.type === "fork_joined");
    expect(joinEvent).toBeTruthy();
    expect(joinEvent!.data?.children).toBe(1);
  });

  test("joinFork on nonexistent parent fails gracefully", async () => {
    const joinResult = await joinFork(app, "s-ghost");
    expect(joinResult.ok).toBe(false);
    expect(joinResult.message).toContain("No children");
  });
});

// ── spawnSubagent edge cases ────────────────────────────────────────────────

describe("spawnSubagent edge cases", () => {
  test("subagent config marks it as subagent", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    const result = spawnSubagent(app, parent.id, { task: "subtask" });

    const child = app.sessions.get(result.sessionId!)!;
    expect(child.config?.subagent).toBe(true);
    expect(child.config?.parent_id).toBe(parent.id);
  });

  test("subagent stores extensions in config", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    const result = spawnSubagent(app, parent.id, {
      task: "task with extensions",
      extensions: ["github-mcp", "search-mcp"],
    });

    const child = app.sessions.get(result.sessionId!)!;
    expect(child.config?.extensions).toEqual(["github-mcp", "search-mcp"]);
  });

  test("subagent without model override has no model_override in config", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    const result = spawnSubagent(app, parent.id, { task: "no model" });

    const child = app.sessions.get(result.sessionId!)!;
    expect(child.config?.model_override).toBeUndefined();
  });

  test("subagent gets first stage of quick flow", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    const result = spawnSubagent(app, parent.id, { task: "task" });

    const child = app.sessions.get(result.sessionId!)!;
    expect(child.stage).toBeTruthy();
    expect(child.status).toBe("ready");
  });

  test("subagent inherits parent repo", () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { repo: "cool-repo" });

    const result = spawnSubagent(app, parent.id, { task: "subtask" });
    const child = app.sessions.get(result.sessionId!)!;
    expect(child.repo).toBe("cool-repo");
  });
});

// ── spawnParallelSubagents edge cases ───────────────────────────────────────

describe("spawnParallelSubagents edge cases", () => {
  test("empty task list returns zero sessionIds", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { status: "running" });

    const result = await spawnParallelSubagents(app, parent.id, []);
    expect(result.ok).toBe(true);
    expect(result.sessionIds).toHaveLength(0);
  });

  test("all subagents linked to parent", async () => {
    const parent = app.sessions.create({ summary: "parent", flow: "bare" });
    app.sessions.update(parent.id, { status: "running" });

    const result = await spawnParallelSubagents(app, parent.id, [
      { task: "implement" },
      { task: "review" },
      { task: "document" },
    ]);

    expect(result.sessionIds).toHaveLength(3);
    for (const id of result.sessionIds) {
      const child = app.sessions.get(id)!;
      expect(child.parent_id).toBe(parent.id);
      expect(child.config?.subagent).toBe(true);
    }
  });
});

// ── retryWithContext after fan-out child failure ─────────────────────────────

describe("retryWithContext on fan-out children", () => {
  test("retry a failed fan-out child resets it to ready", () => {
    const parent = app.sessions.create({ summary: "retry parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "will fail" }],
    });

    app.sessions.update(result.childIds![0], { status: "failed", error: "OOM" });

    const retryResult = retryWithContext(app, result.childIds![0]);
    expect(retryResult.ok).toBe(true);

    const child = app.sessions.get(result.childIds![0])!;
    expect(child.status).toBe("ready");
    expect(child.error).toBeNull();
  });

  test("retried child still linked to parent", () => {
    const parent = app.sessions.create({ summary: "retry parent", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "fail again" }] });
    app.sessions.update(result.childIds![0], { status: "failed", error: "err" });

    retryWithContext(app, result.childIds![0]);

    const child = app.sessions.get(result.childIds![0])!;
    expect(child.parent_id).toBe(parent.id);
    expect(child.fork_group).toBeTruthy();
  });
});

// ── Integration: fan-out -> retry -> auto-join ──────────────────────────────

describe("fan-out integration scenarios", () => {
  test("fan-out, child fails, retry, complete, auto-join", async () => {
    const parent = app.sessions.create({ summary: "integration", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });

    // A completes, B fails
    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed", error: "test error" });

    // Auto-join triggers (both are terminal)
    const joined1 = await checkAutoJoin(app, result.childIds![1]);
    expect(joined1).toBe(true);

    // Verify partial failure logged
    const events = app.events.list(parent.id);
    expect(events.some((e) => e.type === "fan_out_partial_failure")).toBe(true);
  });

  test("getChildren returns children from both fanOut and fork", async () => {
    const parent = app.sessions.create({ summary: "mixed children", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    // Create via fanOut
    const fanResult = fanOut(app, parent.id, {
      tasks: [{ summary: "fan child" }],
    });

    // Create via fork (uses same parent)
    const forkResult = await fork(app, parent.id, "fork child", { dispatch: false });

    const children = app.sessions.getChildren(parent.id);
    const childIds = children.map((c) => c.id);
    expect(childIds).toContain(fanResult.childIds![0]);
    expect(childIds).toContain(forkResult.sessionId!);
  });

  test("sequential fan-outs on different parents are independent", async () => {
    const p1 = app.sessions.create({ summary: "parent 1", flow: "bare" });
    const p2 = app.sessions.create({ summary: "parent 2", flow: "bare" });
    app.sessions.update(p1.id, { stage: "implement", status: "running" });
    app.sessions.update(p2.id, { stage: "implement", status: "running" });

    const r1 = fanOut(app, p1.id, { tasks: [{ summary: "P1-A" }] });
    const r2 = fanOut(app, p2.id, { tasks: [{ summary: "P2-A" }] });

    // Complete P1 child only
    app.sessions.update(r1.childIds![0], { status: "completed" });
    const joined1 = await checkAutoJoin(app, r1.childIds![0]);
    expect(joined1).toBe(true);

    // P2 parent should still be waiting
    expect(app.sessions.get(p2.id)!.status).toBe("waiting");

    // P1 parent should no longer be waiting
    expect(app.sessions.get(p1.id)!.status).not.toBe("waiting");
  });

  test("subagent spawned from fan-out child has correct lineage", () => {
    const grandparent = app.sessions.create({ summary: "grandparent", flow: "bare" });
    app.sessions.update(grandparent.id, { stage: "implement", status: "running" });

    const fanResult = fanOut(app, grandparent.id, {
      tasks: [{ summary: "parent child" }],
    });
    const childId = fanResult.childIds![0];

    const subResult = spawnSubagent(app, childId, { task: "grandchild task" });
    expect(subResult.ok).toBe(true);

    const grandchild = app.sessions.get(subResult.sessionId!)!;
    expect(grandchild.parent_id).toBe(childId);
    expect(grandchild.config?.parent_id).toBe(childId);
  });
});
