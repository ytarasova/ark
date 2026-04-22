/**
 * Tests that deleteSessionAsync cleans up the associated worktree directory.
 * (store.deleteSession is now DB-only; worktree cleanup moved to session layer)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { deleteSessionAsync } from "../services/session-lifecycle.js";
import { AppContext } from "../app.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

describe("deleteSessionAsync worktree cleanup", async () => {
  it("removes worktree directory when session is deleted", async () => {
    const session = await getApp().sessions.create({ summary: "wt-cleanup-test", repo: "/tmp/fake-repo" });
    const wtPath = join(getApp().config.worktreesDir, session.id);

    // Simulate a worktree directory existing
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, "dummy.txt"), "test");
    expect(existsSync(wtPath)).toBe(true);

    await deleteSessionAsync(app, session.id);

    expect(existsSync(wtPath)).toBe(false);
    // Soft-delete: session still exists in DB with status "deleting"
    const after = await getApp().sessions.get(session.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });

  it("succeeds when no worktree directory exists", async () => {
    const session = await getApp().sessions.create({ summary: "no-wt-test", repo: "/tmp/fake-repo" });
    const wtPath = join(getApp().config.worktreesDir, session.id);

    expect(existsSync(wtPath)).toBe(false);

    const result = await deleteSessionAsync(app, session.id);
    expect(result.ok).toBe(true);
    // Soft-delete: session still exists in DB with status "deleting"
    const after = await getApp().sessions.get(session.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });

  it("deletes session even if worktree cleanup fails gracefully", async () => {
    const session = await getApp().sessions.create({ summary: "wt-no-repo-test" });
    const wtPath = join(getApp().config.worktreesDir, session.id);

    // Create a worktree dir but session has no repo -- should still delete
    mkdirSync(wtPath, { recursive: true });

    const result = await deleteSessionAsync(app, session.id);
    expect(result.ok).toBe(true);
    // Soft-delete: session still exists in DB with status "deleting"
    const after = await getApp().sessions.get(session.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
    // Without a repo, falls back to rmSync -- directory should be cleaned up
    expect(existsSync(wtPath)).toBe(false);
  });
});
