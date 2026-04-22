/**
 * Comprehensive tests for deleteSessionAsync -- full session cleanup.
 *
 * Tests DB deletion, event cleanup, worktree removal, hook config removal,
 * and graceful handling of missing tmux/compute.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { AppContext } from "../app.js";
import { writeSettings } from "../claude/claude.js";
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

// ── Unit tests ──────────────────────────────────────────────────────────────

describe("sessionLifecycle.deleteSession", async () => {
  it("soft-deletes session from database", async () => {
    const session = await app.sessionLifecycle.start({
      repo: "/tmp/fake-repo",
      summary: "delete-db-test",
      flow: "bare",
    });

    // Verify it exists
    expect(await app.sessions.get(session.id)).not.toBeNull();

    const result = await app.sessionLifecycle.deleteSession(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Session deleted (undo available for 90s)");

    // Soft-delete: session still exists in DB with status "deleting"
    const after = await app.sessions.get(session.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });

  it("preserves events after soft-delete", async () => {
    const session = await app.sessionLifecycle.start({
      repo: "/tmp/fake-repo",
      summary: "delete-events-test",
      flow: "bare",
    });

    // Log some extra events
    await app.events.log(session.id, "test_event_1", { actor: "test", data: { foo: 1 } });
    await app.events.log(session.id, "test_event_2", { actor: "test", data: { bar: 2 } });

    // Verify events exist (session_created + stage_ready + 2 custom)
    const eventsBefore = await app.events.list(session.id);
    expect(eventsBefore.length).toBeGreaterThanOrEqual(3);

    await app.sessionLifecycle.deleteSession(session.id);

    // Soft-delete preserves events (plus session_deleted event)
    const eventsAfter = await app.events.list(session.id);
    expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
  });

  it("returns ok:false for nonexistent session", async () => {
    const result = await app.sessionLifecycle.deleteSession("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("cleans up worktree directory if it exists (no repo -- rmSync path)", async () => {
    // Create session with no repo/workdir so cleanup uses direct rmSync
    const session = await app.sessions.create({
      summary: "delete-worktree-test",
    });

    // Create a fake worktree directory under WORKTREES_DIR
    const wtPath = join(getApp().config.worktreesDir, session.id);
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, "dummy.txt"), "test content");
    expect(existsSync(wtPath)).toBe(true);

    await app.sessionLifecycle.deleteSession(session.id);

    // Worktree directory should be gone (rmSync fallback)
    expect(existsSync(wtPath)).toBe(false);
    // Soft-delete: session still exists in DB with status "deleting"
    const after = await app.sessions.get(session.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });

  it("does NOT touch filesystem when no worktree exists", async () => {
    // Use the repo dir as workdir (simulating a direct repo, no worktree)
    const repoDir = join(app.config.arkDir, "fake-direct-repo");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "file.txt"), "important");

    const session = await app.sessionLifecycle.start({
      repo: repoDir,
      workdir: repoDir,
      summary: "delete-no-worktree-test",
      flow: "bare",
    });

    // No worktree dir exists under WORKTREES_DIR
    const wtPath = join(getApp().config.worktreesDir, session.id);
    expect(existsSync(wtPath)).toBe(false);

    await app.sessionLifecycle.deleteSession(session.id);

    // The repo dir should still exist and be intact
    expect(existsSync(repoDir)).toBe(true);
    expect(readFileSync(join(repoDir, "file.txt"), "utf-8")).toBe("important");
    // Soft-delete: session still exists in DB with status "deleting"
    const after = await app.sessions.get(session.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });

  it("removes hook config from workdir", async () => {
    // Create a workdir with hooks written
    const workdir = join(app.config.arkDir, "hook-test-workdir");
    mkdirSync(workdir, { recursive: true });

    const session = await app.sessionLifecycle.start({
      repo: workdir,
      workdir,
      summary: "delete-hooks-test",
      flow: "bare",
    });

    // Write hooks config into the workdir
    writeSettings(session.id, "http://localhost:19100", workdir);

    // Verify hooks file exists and has ark hooks
    const settingsPath = join(workdir, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);
    const beforeSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(beforeSettings.hooks).toBeDefined();
    expect(Object.keys(beforeSettings.hooks).length).toBeGreaterThan(0);

    await app.sessionLifecycle.deleteSession(session.id);

    // After deletion, hooks should be cleaned from settings
    if (existsSync(settingsPath)) {
      const afterSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      // All ark hooks should be removed (hooks key should be absent or empty)
      expect(afterSettings.hooks).toBeUndefined();
    }
    // Soft-delete: session still exists in DB with status "deleting"
    const after = await app.sessions.get(session.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });

  // ── Integration patterns ──────────────────────────────────────────────────

  it("works when session has no tmux session (session_id is null)", async () => {
    const session = await app.sessionLifecycle.start({
      repo: "/tmp/fake-repo",
      summary: "no-tmux-test",
      flow: "bare",
    });

    // Verify session_id is null (not dispatched)
    expect(session.session_id).toBeNull();

    // Should not throw
    const result = await app.sessionLifecycle.deleteSession(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Session deleted (undo available for 90s)");
    // Soft-delete: session still exists with status "deleting"
    const after1 = await app.sessions.get(session.id);
    expect(after1).not.toBeNull();
    expect(after1!.status).toBe("deleting");
  });

  it("works when session has no compute (compute_name is null)", async () => {
    const session = await app.sessionLifecycle.start({
      repo: "/tmp/fake-repo",
      summary: "no-compute-test",
      flow: "bare",
      // No compute_name specified
    });

    // Verify compute_name is null
    expect(session.compute_name).toBeNull();

    // Should not throw
    const result = await app.sessionLifecycle.deleteSession(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Session deleted (undo available for 90s)");
    // Soft-delete: session still exists with status "deleting"
    const after = await app.sessions.get(session.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });
});
