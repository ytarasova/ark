/**
 * Tests for new features: interrupt, worktreeDiff, createWorktreePR,
 * TodoRepository, runVerification, flow verify field, and RepoConfig verify field.
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { withTestContext } from "./test-helpers.js";
import { worktreeDiff, createWorktreePR, mergeWorktreePR } from "../services/worktree/index.js";
import { executeAction } from "../services/actions/index.js";
import { getStageDefinition } from "../state/flow.js";
import { loadRepoConfig } from "../repo-config.js";
import { getApp } from "./test-helpers.js";

withTestContext();

// ── Test 1: interrupt(getApp()) ───────────────────────────────────────────────────────

describe("interrupt(getApp())", async () => {
  it("returns error for non-existent session", async () => {
    const result = await getApp().sessionLifecycle.interrupt("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns error when session is not running", async () => {
    const session = await getApp().sessions.create({ summary: "interrupt-not-running" });
    await getApp().sessions.update(session.id, { status: "pending" });

    const result = await getApp().sessionLifecycle.interrupt(session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not running");
  });

  it.skip("returns error when session has no tmux session_id", async () => {
    // The running-invariant (session.ts update()) prevents constructing a
    // running session with session_id=null -- exactly the state this test
    // tried to assert against. The defensive guard in suspend.ts remains
    // for belt-and-suspenders safety but this branch is no longer reachable
    // via the repository. Skipped until/unless the branch is exercised
    // through a raw-DB-manipulation route.
  });

  it("is exposed on the SessionLifecycle service", () => {
    expect(typeof getApp().sessionLifecycle.interrupt).toBe("function");
  });
});

// ── Test 2: worktreeDiff(getApp()) ────────────────────────────────────────────────────

describe("worktreeDiff(getApp())", async () => {
  it("returns error for non-existent session", async () => {
    const result = await worktreeDiff(getApp(), "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns error when session has no workdir", async () => {
    const session = await getApp().sessions.create({ summary: "diff-no-workdir" });
    // No workdir or repo set

    const result = await worktreeDiff(getApp(), session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No workdir or repo");
  });

  it("returns error when branch cannot be determined", async () => {
    const session = await getApp().sessions.create({ summary: "diff-no-branch" });
    await getApp().sessions.update(session.id, {
      workdir: "/tmp/nonexistent-workdir",
      repo: "/tmp/nonexistent-repo",
    });

    const result = await worktreeDiff(getApp(), session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Cannot determine branch");
  });
});

// ── Test 2b: worktreeDiff re-review flagging ─────────────────────────────────

describe("worktreeDiff re-review flagging", async () => {
  it("returns empty modifiedSinceReview for non-existent session", async () => {
    const result = await worktreeDiff(getApp(), "s-nonexistent");
    expect(result.modifiedSinceReview).toEqual([]);
  });

  it("returns modifiedSinceReview in the result shape", async () => {
    const session = await getApp().sessions.create({ summary: "re-review-test" });
    const result = await worktreeDiff(getApp(), session.id);
    expect(Array.isArray(result.modifiedSinceReview)).toBe(true);
  });
});

// ── Test 3: createWorktreePR(getApp()) ────────────────────────────────────────────────

describe("createWorktreePR(getApp())", async () => {
  it("returns error for non-existent session", async () => {
    const result = await createWorktreePR(getApp(), "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns error when session has no repo", async () => {
    const session = await getApp().sessions.create({ summary: "pr-no-repo" });
    // No repo set

    const result = await createWorktreePR(getApp(), session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no repo");
  });

  it("returns error when branch cannot be determined", async () => {
    const session = await getApp().sessions.create({ summary: "pr-no-branch" });
    await getApp().sessions.update(session.id, { repo: "/tmp/nonexistent-repo" });

    const result = await createWorktreePR(getApp(), session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Cannot determine worktree branch");
  });

  it("is exported as a function", () => {
    expect(typeof createWorktreePR).toBe("function");
  });
});

// ── Test 3b: mergeWorktreePR(getApp()) ──────────────────────────────────────────────

describe("mergeWorktreePR(getApp())", async () => {
  it("returns error for non-existent session", async () => {
    const result = await mergeWorktreePR(getApp(), "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns error when session has no PR URL", async () => {
    const session = await getApp().sessions.create({ summary: "merge-no-pr" });
    const result = await mergeWorktreePR(getApp(), session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no PR URL");
  });

  it("returns error when session has no repo", async () => {
    const session = await getApp().sessions.create({ summary: "merge-no-repo" });
    await getApp().sessions.update(session.id, { pr_url: "https://github.com/org/repo/pull/1" });
    const result = await mergeWorktreePR(getApp(), session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no repo");
  });

  it("is exported as a function", () => {
    expect(typeof mergeWorktreePR).toBe("function");
  });
});

// ── Test 3c: executeAction auto_merge ─────────────────────────────────────────
// Note: The success path (mergeWorktreePR succeeds -> session goes to "waiting"
// instead of immediately completing) is tested in pr-merge-poller.test.ts.
// These tests verify the error paths which remain unchanged.

describe("executeAction auto_merge", async () => {
  it("returns error when session has no PR URL", async () => {
    const session = await getApp().sessions.create({ summary: "auto-merge-no-pr", flow: "autonomous-sdlc" });
    await getApp().sessions.update(session.id, { stage: "merge" });
    const result = await executeAction(getApp(), session.id, "auto_merge");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no PR URL");
  });

  it("returns error for non-existent session", async () => {
    const result = await executeAction(getApp(), "s-nonexistent", "auto_merge");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns error when session has no repo", async () => {
    const session = await getApp().sessions.create({ summary: "auto-merge-no-repo", flow: "autonomous-sdlc" });
    await getApp().sessions.update(session.id, {
      stage: "merge",
      pr_url: "https://github.com/org/repo/pull/1",
    });
    const result = await executeAction(getApp(), session.id, "auto_merge");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no repo");
  });

  it("does not advance session on merge failure (stays in current state)", async () => {
    const session = await getApp().sessions.create({ summary: "auto-merge-fail-no-advance", flow: "autonomous-sdlc" });
    await getApp().sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      stage: "merge",
      status: "running",
      pr_url: "https://github.com/org/repo/pull/1",
    });
    const result = await executeAction(getApp(), session.id, "auto_merge");
    expect(result.ok).toBe(false);
    // Session should NOT have been advanced or set to waiting
    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("running");
    expect(updated.stage).toBe("merge");
  });
});

// ── Test 4: TodoRepository ────────────────────────────────────────────────────

describe("TodoRepository", () => {
  it("add() creates a todo", async () => {
    const todo = await getApp().todos.add("s-todo-1", "Write tests");
    expect(todo.id).toBeDefined();
    expect(todo.session_id).toBe("s-todo-1");
    expect(todo.content).toBe("Write tests");
    expect(todo.done).toBe(false);
    expect(todo.created_at).toBeDefined();
  });

  it("list() returns todos for a session", async () => {
    await getApp().todos.add("s-list-1", "First item");
    await getApp().todos.add("s-list-1", "Second item");

    const todos = await getApp().todos.list("s-list-1");
    expect(todos).toHaveLength(2);
    expect(todos[0].content).toBe("First item");
    expect(todos[1].content).toBe("Second item");
  });

  it("list() does not return todos from other sessions", async () => {
    await getApp().todos.add("s-iso-a", "Session A todo");
    await getApp().todos.add("s-iso-b", "Session B todo");

    const todosA = await getApp().todos.list("s-iso-a");
    const todosB = await getApp().todos.list("s-iso-b");

    expect(todosA).toHaveLength(1);
    expect(todosA[0].content).toBe("Session A todo");
    expect(todosB).toHaveLength(1);
    expect(todosB[0].content).toBe("Session B todo");
  });

  it("toggle() flips done state", async () => {
    const todo = await getApp().todos.add("s-toggle-1", "Toggle me");
    expect(todo.done).toBe(false);

    const toggled = await getApp().todos.toggle(todo.id);
    expect(toggled).not.toBeNull();
    expect(toggled!.done).toBe(true);

    const toggledBack = await getApp().todos.toggle(todo.id);
    expect(toggledBack).not.toBeNull();
    expect(toggledBack!.done).toBe(false);
  });

  it("toggle() returns null for non-existent id", async () => {
    const result = await getApp().todos.toggle(999999);
    expect(result).toBeNull();
  });

  it("delete() removes a todo", async () => {
    const todo = await getApp().todos.add("s-del-1", "Delete me");
    expect(await getApp().todos.list("s-del-1")).toHaveLength(1);

    const deleted = await getApp().todos.delete(todo.id);
    expect(deleted).toBe(true);
    expect(await getApp().todos.list("s-del-1")).toHaveLength(0);
  });

  it("allDone() returns true when no todos exist", async () => {
    expect(await getApp().todos.allDone("s-empty-session")).toBe(true);
  });

  it("allDone() returns true when all todos are done", async () => {
    const t1 = await getApp().todos.add("s-alldone-1", "Item 1");
    const t2 = await getApp().todos.add("s-alldone-1", "Item 2");
    await getApp().todos.toggle(t1.id);
    await getApp().todos.toggle(t2.id);

    expect(await getApp().todos.allDone("s-alldone-1")).toBe(true);
  });

  it("allDone() returns false when undone todos exist", async () => {
    const t1 = await getApp().todos.add("s-notdone-1", "Item 1");
    await getApp().todos.add("s-notdone-1", "Item 2");
    await getApp().todos.toggle(t1.id); // only one done

    expect(await getApp().todos.allDone("s-notdone-1")).toBe(false);
  });

  it("deleteForSession() removes all todos for a session", async () => {
    await getApp().todos.add("s-purge-1", "Todo A");
    await getApp().todos.add("s-purge-1", "Todo B");
    await getApp().todos.add("s-purge-2", "Todo C"); // different session

    await getApp().todos.deleteForSession("s-purge-1");

    expect(await getApp().todos.list("s-purge-1")).toHaveLength(0);
    expect(await getApp().todos.list("s-purge-2")).toHaveLength(1);
  });
});

// ── Test 5: runVerification(getApp()) ─────────────────────────────────────────────────

describe("runVerification(getApp())", async () => {
  it("returns ok when no todos and no verify scripts", async () => {
    const session = await getApp().sessions.create({ summary: "verify-clean" });

    const result = await getApp().sessionLifecycle.runVerification(session.id);
    expect(result.ok).toBe(true);
    expect(result.todosResolved).toBe(true);
    expect(result.pendingTodos).toHaveLength(0);
    expect(result.scriptResults).toHaveLength(0);
    expect(result.message).toBe("Verification passed");
  });

  it("fails when undone todos exist", async () => {
    const session = await getApp().sessions.create({ summary: "verify-todos" });
    await getApp().todos.add(session.id, "Must do this");

    const result = await getApp().sessionLifecycle.runVerification(session.id);
    expect(result.ok).toBe(false);
    expect(result.todosResolved).toBe(false);
    expect(result.pendingTodos).toHaveLength(1);
  });

  it("returns pending todo content in message", async () => {
    const session = await getApp().sessions.create({ summary: "verify-msg" });
    await getApp().todos.add(session.id, "Fix the bug");
    await getApp().todos.add(session.id, "Add tests");

    const result = await getApp().sessionLifecycle.runVerification(session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Fix the bug");
    expect(result.message).toContain("Add tests");
    expect(result.message).toContain("unresolved todo");
  });

  it("returns error for non-existent session", async () => {
    const result = await getApp().sessionLifecycle.runVerification("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("passes when all todos are done", async () => {
    const session = await getApp().sessions.create({ summary: "verify-done-todos" });
    const t1 = await getApp().todos.add(session.id, "Already done");
    await getApp().todos.toggle(t1.id);

    const result = await getApp().sessionLifecycle.runVerification(session.id);
    expect(result.ok).toBe(true);
    expect(result.todosResolved).toBe(true);
    expect(result.pendingTodos).toHaveLength(0);
  });

  it("routes verify scripts through the injected runScript seam", async () => {
    // Use a throwaway temp dir as workdir so loadRepoConfig returns clean
    // (no inherited verify scripts); configure a flow with two verify
    // scripts so the seam is hit twice, once successful and once failing.
    const tmp = join(process.env.TMPDIR ?? "/tmp", `ark-verify-seam-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    await getApp().flows.save("verify-flow", {
      name: "verify-flow",
      stages: [{ name: "only", agent: "worker", verify: ["good", "bad"] }],
    } as any);

    const session = await getApp().sessions.create({
      summary: "verify-stub",
      flow: "verify-flow",
      workdir: tmp,
    });
    await getApp().sessions.update(session.id, { stage: "only" });

    const calls: Array<{ script: string; cwd: string | undefined }> = [];
    const result = await getApp().sessionLifecycle.runVerification(session.id, {
      runScript: async (script, opts) => {
        calls.push({ script, cwd: opts.cwd });
        if (script === "good") return { stdout: "ok\n", stderr: "" };
        throw { stdout: "", stderr: "boom", message: "failed" };
      },
      timeoutMs: 1000,
    });

    expect(calls).toEqual([
      { script: "good", cwd: tmp },
      { script: "bad", cwd: tmp },
    ]);
    expect(result.ok).toBe(false);
    expect(result.scriptResults).toHaveLength(2);
    expect(result.scriptResults[0]).toEqual({ script: "good", passed: true, output: "ok\n" });
    expect(result.scriptResults[1].passed).toBe(false);
    expect(result.scriptResults[1].output).toContain("boom");
    expect(result.message).toContain("verify failed: bad");
  });

  it("reports verify success when all injected scripts pass", async () => {
    const tmp = join(process.env.TMPDIR ?? "/tmp", `ark-verify-pass-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    await getApp().flows.save("verify-flow-pass", {
      name: "verify-flow-pass",
      stages: [{ name: "only", agent: "worker", verify: ["lint", "test"] }],
    } as any);

    const session = await getApp().sessions.create({
      summary: "verify-stub-pass",
      flow: "verify-flow-pass",
      workdir: tmp,
    });
    await getApp().sessions.update(session.id, { stage: "only" });

    const result = await getApp().sessionLifecycle.runVerification(session.id, {
      runScript: async () => ({ stdout: "", stderr: "" }),
    });
    expect(result.ok).toBe(true);
    expect(result.scriptResults).toHaveLength(2);
    expect(result.scriptResults.every((r) => r.passed)).toBe(true);
    expect(result.message).toBe("Verification passed");
  });
});

// ── Test 6: Flow verify field ─────────────────────────────────────────────────

describe("StageDefinition verify field", () => {
  it("getStageDefinition is exported as a function", () => {
    expect(typeof getStageDefinition).toBe("function");
  });

  it("returns null for nonexistent flow/stage", () => {
    const stage = getStageDefinition(getApp(), "nonexistent-flow", "nonexistent-stage");
    expect(stage).toBeNull();
  });

  it("StageDefinition type supports verify as string array", () => {
    // Construct a StageDefinition with verify to prove the type accepts it
    const stage: import("../flow.js").StageDefinition = {
      name: "test-stage",
      gate: "auto",
      verify: ["npm test", "npm run lint"],
    };
    expect(stage.verify).toEqual(["npm test", "npm run lint"]);
    expect(stage.verify).toHaveLength(2);
  });
});

// ── Test 7: RepoConfig verify field ───────────────────────────────────────────

describe("RepoConfig verify field", () => {
  it("loadRepoConfig reads verify field from .ark.yaml", () => {
    const tmpDir = join(getApp().arkDir, "test-repo-config");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, ".ark.yaml"), "verify:\n  - npm test\n  - npm run lint\n");

    const config = loadRepoConfig(tmpDir);
    expect(config.verify).toEqual(["npm test", "npm run lint"]);
  });

  it("loadRepoConfig returns empty object when no config file exists", () => {
    const tmpDir = join(getApp().arkDir, "test-repo-empty");
    mkdirSync(tmpDir, { recursive: true });

    const config = loadRepoConfig(tmpDir);
    expect(config.verify).toBeUndefined();
  });

  it("loadRepoConfig reads other fields alongside verify", () => {
    const tmpDir = join(getApp().arkDir, "test-repo-full");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, ".ark.yaml"), "flow: quick\ncompute: local\nverify:\n  - make test\n");

    const config = loadRepoConfig(tmpDir);
    expect(config.flow).toBe("quick");
    expect(config.compute).toBe("local");
    expect(config.verify).toEqual(["make test"]);
  });
});

// ── Test 8: archive(getApp()) and restore(getApp()) ──────────────────────────────────────────

describe("archive(getApp()) and restore(getApp())", async () => {
  it("archive sets status to archived", async () => {
    const session = await getApp().sessions.create({ summary: "archive-test" });
    await getApp().sessions.update(session.id, { status: "completed" });

    const result = await getApp().sessionLifecycle.archive(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Session archived");

    const updated = await getApp().sessions.get(session.id);
    expect(updated!.status).toBe("archived");
  });

  it("archive returns error for non-existent session", async () => {
    const result = await getApp().sessionLifecycle.archive("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("restore sets status to stopped", async () => {
    const session = await getApp().sessions.create({ summary: "restore-test" });
    await getApp().sessions.update(session.id, { status: "completed" });
    await getApp().sessionLifecycle.archive(session.id);

    const result = await getApp().sessionLifecycle.restore(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Session restored");

    const updated = await getApp().sessions.get(session.id);
    expect(updated!.status).toBe("stopped");
  });

  it("restore returns error when not archived", async () => {
    const session = await getApp().sessions.create({ summary: "restore-not-archived" });
    await getApp().sessions.update(session.id, { status: "completed" });

    const result = await getApp().sessionLifecycle.restore(session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not archived");
  });

  it("archived sessions excluded from default list", async () => {
    const session = await getApp().sessions.create({ summary: "archive-list-test" });
    await getApp().sessions.update(session.id, { status: "completed" });
    await getApp().sessionLifecycle.archive(session.id);

    // Default list should not include archived
    const defaultList = await getApp().sessions.list();
    const found = defaultList.find((s: any) => s.id === session.id);
    expect(found).toBeUndefined();

    // Filtering for archived should include it
    const archivedList = await getApp().sessions.list({ status: "archived" });
    const foundArchived = archivedList.find((s: any) => s.id === session.id);
    expect(foundArchived).toBeDefined();
    expect(foundArchived!.status).toBe("archived");
  });
});

// ── cli-agent executor ──────────────────────────────────────────────────────

import { cliAgentExecutor } from "../executors/cli-agent.js";

describe("cli-agent executor", async () => {
  it("is exported and registered", () => {
    expect(typeof cliAgentExecutor).toBe("object");
    expect(cliAgentExecutor.name).toBe("cli-agent");
  });

  it("launch fails without command", async () => {
    const result = await cliAgentExecutor.launch({
      sessionId: "s-test",
      workdir: "/tmp",
      task: "test",
      agent: {
        name: "test",
        model: "test",
        max_turns: 1,
        system_prompt: "",
        tools: [],
        skills: [],
        mcp_servers: [],
        permission_mode: "bypassPermissions",
        env: {},
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no command");
  });

  it("status returns not_found for unknown handle", async () => {
    const status = await cliAgentExecutor.status("nonexistent-handle");
    expect(status.state).toBe("not_found"); // tmux session doesn't exist = not_found
  });
});

// ── status poller ───────────────────────────────────────────────────────────

describe("status poller", async () => {
  it("exports startStatusPoller and stopStatusPoller", async () => {
    const mod = await import("../executors/status-poller.js");
    expect(typeof mod.startStatusPoller).toBe("function");
    expect(typeof mod.stopStatusPoller).toBe("function");
    expect(typeof mod.stopAllPollers).toBe("function");
  });
});
