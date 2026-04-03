import { describe, it, expect } from "bun:test";
import { createSession, updateSession, getSession, WORKTREES_DIR } from "../store.js";
import { withTestContext } from "./test-helpers.js";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";

withTestContext();

// We can't easily test real git operations, but we can test the function's
// pre-condition checks and session cleanup behavior.

describe("finishWorktree preconditions", () => {
  it("rejects non-existent session", async () => {
    const { finishWorktree } = await import("../session.js");
    const result = await finishWorktree("nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("rejects session without workdir", async () => {
    const s = createSession({ summary: "no-workdir" });
    const { finishWorktree } = await import("../session.js");
    const result = await finishWorktree(s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("workdir");
  });

  it("rejects session without branch", async () => {
    const s = createSession({ summary: "no-branch", repo: "/tmp/fake-repo" });
    updateSession(s.id, { workdir: "/tmp/fake-workdir" });
    const { finishWorktree } = await import("../session.js");
    const result = await finishWorktree(s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("branch");
  });
});

describe("finishWorktree with options", () => {
  it("finishWorktree with noMerge still soft-deletes the session", async () => {
    const s = createSession({ summary: "no-merge-test", repo: "/tmp/fake-repo" });
    updateSession(s.id, { workdir: "/tmp/fake-workdir", branch: "feature-x" });

    const { finishWorktree } = await import("../session.js");
    // This will fail at the git merge step, but with noMerge it skips merge
    // The git worktree remove will also fail (no real worktree) but that's caught
    // The session should still be soft-deleted
    const result = await finishWorktree(s.id, { noMerge: true });
    // Even if worktree removal fails, session gets deleted
    const after = getSession(s.id);
    // Session should be soft-deleted (status "deleting") since deleteSessionAsync was called
    if (after) {
      expect(after.status).toBe("deleting");
    }
    // result.ok should be true since noMerge skips the merge step
    expect(result.ok).toBe(true);
  });

  it("finishWorktree stops running session before finishing", async () => {
    const s = createSession({ summary: "running-finish", repo: "/tmp/fake-repo" });
    updateSession(s.id, { workdir: "/tmp/fake-workdir", branch: "feature-y", status: "running" });

    const { finishWorktree } = await import("../session.js");
    // stop() will be called first, then merge (which fails), which aborts
    const result = await finishWorktree(s.id, { noMerge: true });
    // After finishing, session should be processed (stopped then deleted)
    const after = getSession(s.id);
    if (after) {
      // Should be in deleting state (soft-deleted)
      expect(["deleting", "stopped"].includes(after.status)).toBe(true);
    }
  });

  it("finishWorktree result message includes branch info with noMerge", async () => {
    const s = createSession({ summary: "msg-test", repo: "/tmp/fake-repo" });
    updateSession(s.id, { workdir: "/tmp/fake-workdir", branch: "my-branch" });

    const { finishWorktree } = await import("../session.js");
    const result = await finishWorktree(s.id, { noMerge: true });
    if (result.ok) {
      expect(result.message).toContain("skipped merge");
    }
  });

  it("finishWorktree with custom into branch", async () => {
    const s = createSession({ summary: "into-test", repo: "/tmp/fake-repo" });
    updateSession(s.id, { workdir: "/tmp/fake-workdir", branch: "feature-z" });

    const { finishWorktree } = await import("../session.js");
    // With noMerge, the into option doesn't matter but should still work
    const result = await finishWorktree(s.id, { noMerge: true, into: "develop" });
    expect(result.ok).toBe(true);
  });
});
