/**
 * Tests that stop() cleans up the associated worktree directory.
 * Worktree cleanup is provider-independent via removeSessionWorktree().
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { stop } from "../services/session-lifecycle.js";
import { removeSessionWorktree } from "../services/workspace-service.js";
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

describe("stop() worktree cleanup", async () => {
  it("removes worktree directory when session is stopped", async () => {
    const session = await getApp().sessions.create({ summary: "stop-wt-test", repo: "/tmp/fake-repo" });
    const wtPath = join(getApp().config.worktreesDir, session.id);

    // Simulate a worktree directory existing
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, "dummy.txt"), "test");
    expect(existsSync(wtPath)).toBe(true);

    await stop(app, session.id);

    expect(existsSync(wtPath)).toBe(false);
  });

  it("succeeds when no worktree directory exists on stop", async () => {
    const session = await getApp().sessions.create({ summary: "stop-no-wt-test", repo: "/tmp/fake-repo" });
    const wtPath = join(getApp().config.worktreesDir, session.id);

    expect(existsSync(wtPath)).toBe(false);

    const result = await stop(app, session.id);
    expect(result.ok).toBe(true);
  });

  it("stops session even if worktree cleanup fails gracefully", async () => {
    const session = await getApp().sessions.create({ summary: "stop-wt-no-repo-test" });
    const wtPath = join(getApp().config.worktreesDir, session.id);

    // Create a worktree dir but session has no repo -- falls back to rmSync
    mkdirSync(wtPath, { recursive: true });

    const result = await stop(app, session.id);
    expect(result.ok).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
  });
});

describe("removeSessionWorktree()", async () => {
  it("removes directory via rmSync fallback when no repo is set", async () => {
    const session = await getApp().sessions.create({ summary: "rmwt-no-repo" });
    const wtPath = join(getApp().config.worktreesDir, session.id);

    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, "file.txt"), "content");
    expect(existsSync(wtPath)).toBe(true);

    await removeSessionWorktree(app, session);
    expect(existsSync(wtPath)).toBe(false);
  });

  it("is a no-op when worktree directory does not exist", async () => {
    const session = await getApp().sessions.create({ summary: "rmwt-missing" });
    const wtPath = join(getApp().config.worktreesDir, session.id);

    expect(existsSync(wtPath)).toBe(false);
    // Should not throw
    await removeSessionWorktree(app, session);
    expect(existsSync(wtPath)).toBe(false);
  });

  it("removes nested directory structure", async () => {
    const session = await getApp().sessions.create({ summary: "rmwt-nested" });
    const wtPath = join(getApp().config.worktreesDir, session.id);

    mkdirSync(join(wtPath, "src", "deep"), { recursive: true });
    writeFileSync(join(wtPath, "src", "deep", "file.ts"), "export {}");
    expect(existsSync(wtPath)).toBe(true);

    await removeSessionWorktree(app, session);
    expect(existsSync(wtPath)).toBe(false);
  });
});
