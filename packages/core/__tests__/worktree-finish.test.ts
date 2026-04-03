import { describe, it, expect } from "bun:test";
import { createSession, updateSession, WORKTREES_DIR } from "../store.js";
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
