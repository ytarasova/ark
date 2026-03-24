/**
 * Tests that deleteSession cleans up the associated worktree directory.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createTestContext, setContext, resetContext,
  deleteSession, getSession,
} from "../index.js";
import { createSession } from "../store.js";
import type { TestContext } from "../store.js";

let ctx: TestContext;

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

describe("deleteSession worktree cleanup", () => {
  it("removes worktree directory when session is deleted", () => {
    const session = createSession({ summary: "wt-cleanup-test", repo: "/tmp/fake-repo" });
    const wtPath = join(ctx.worktreesDir, session.id);

    // Simulate a worktree directory existing
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, "dummy.txt"), "test");
    expect(existsSync(wtPath)).toBe(true);

    deleteSession(session.id);

    expect(existsSync(wtPath)).toBe(false);
    expect(getSession(session.id)).toBeNull();
  });

  it("succeeds when no worktree directory exists", () => {
    const session = createSession({ summary: "no-wt-test", repo: "/tmp/fake-repo" });
    const wtPath = join(ctx.worktreesDir, session.id);

    expect(existsSync(wtPath)).toBe(false);

    const result = deleteSession(session.id);
    expect(result).toBe(true);
    expect(getSession(session.id)).toBeNull();
  });

  it("deletes session even if worktree cleanup fails gracefully", () => {
    const session = createSession({ summary: "wt-no-repo-test" });
    const wtPath = join(ctx.worktreesDir, session.id);

    // Create a worktree dir but session has no repo — should still delete
    mkdirSync(wtPath, { recursive: true });

    const result = deleteSession(session.id);
    expect(result).toBe(true);
    expect(getSession(session.id)).toBeNull();
    // Without a repo, falls back to rmSync — directory should be cleaned up
    expect(existsSync(wtPath)).toBe(false);
  });
});
