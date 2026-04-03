/**
 * Tests that deleteSessionAsync cleans up the associated worktree directory.
 * (store.deleteSession is now DB-only; worktree cleanup moved to session layer)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { getSession, WORKTREES_DIR } from "../index.js";
import { createSession } from "../store.js";
import { deleteSessionAsync } from "../session.js";
import { AppContext, setApp, clearApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

let app: AppContext;

beforeEach(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

describe("deleteSessionAsync worktree cleanup", () => {
  it("removes worktree directory when session is deleted", async () => {
    const session = createSession({ summary: "wt-cleanup-test", repo: "/tmp/fake-repo" });
    const wtPath = join(WORKTREES_DIR(), session.id);

    // Simulate a worktree directory existing
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, "dummy.txt"), "test");
    expect(existsSync(wtPath)).toBe(true);

    await deleteSessionAsync(session.id);

    expect(existsSync(wtPath)).toBe(false);
    // Soft-delete: session still exists in DB with status "deleting"
    const after = getSession(session.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });

  it("succeeds when no worktree directory exists", async () => {
    const session = createSession({ summary: "no-wt-test", repo: "/tmp/fake-repo" });
    const wtPath = join(WORKTREES_DIR(), session.id);

    expect(existsSync(wtPath)).toBe(false);

    const result = await deleteSessionAsync(session.id);
    expect(result.ok).toBe(true);
    // Soft-delete: session still exists in DB with status "deleting"
    const after = getSession(session.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });

  it("deletes session even if worktree cleanup fails gracefully", async () => {
    const session = createSession({ summary: "wt-no-repo-test" });
    const wtPath = join(WORKTREES_DIR(), session.id);

    // Create a worktree dir but session has no repo — should still delete
    mkdirSync(wtPath, { recursive: true });

    const result = await deleteSessionAsync(session.id);
    expect(result.ok).toBe(true);
    // Soft-delete: session still exists in DB with status "deleting"
    const after = getSession(session.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
    // Without a repo, falls back to rmSync — directory should be cleaned up
    expect(existsSync(wtPath)).toBe(false);
  });
});
