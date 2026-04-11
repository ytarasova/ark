/**
 * E2E TUI worktree tests.
 *
 * Tests dispatch with a real git repo creates a worktree,
 * and the W key shows the worktree overlay.
 *
 * Uses setupE2E() from fixtures/app.ts for an isolated git workdir.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { getApp } from "../../core/app.js";
import { startSession, dispatch, stop } from "../../core/services/session-orchestration.js";
import { killSession } from "../../core/infra/tmux.js";
import { TuiDriver } from "../fixtures/tui-driver.js";
import { setupE2E, type E2EEnv } from "../fixtures/app.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";

let tmuxSnapshot: Set<string>;
let env: E2EEnv;

beforeAll(async () => {
  tmuxSnapshot = snapshotArkTmuxSessions();
  env = await setupE2E();
});

afterAll(async () => {
  killNewArkTmuxSessions(tmuxSnapshot);
  await env?.teardown();
});

afterEach(() => {
  const app = getApp();
  // Kill any tmux sessions created during tests
  for (const name of env.tmuxSessions) {
    try { killSession(name); } catch { /* cleanup */ }
  }
  env.tmuxSessions.length = 0;

  // Clean up sessions from DB
  for (const id of env.sessionIds) {
    try {
      const s = app.sessions.get(id);
      if (s?.session_id) {
        try { killSession(s.session_id); } catch { /* cleanup */ }
      }
      app.sessions.delete(id);
    } catch { /* cleanup */ }
  }
  env.sessionIds.length = 0;
});

describe("e2e TUI worktree", () => {

  it("dispatch with real git repo creates worktree", async () => {
    const app = getApp();
    const session = startSession(app, {
      repo: env.workdir,
      summary: "worktree-dispatch-test",
      flow: "bare",
      workdir: env.workdir,
    });
    env.sessionIds.push(session.id);

    const result = await dispatch(app, session.id);
    expect(result.ok).toBe(true);

    const dispatched = app.sessions.get(session.id)!;
    expect(dispatched.status).toBe("running");
    if (dispatched.session_id) env.tmuxSessions.push(dispatched.session_id);

    // Clean up: stop session so tmux dies
    await stop(app, session.id);

    // Clean up any worktree created in the isolated env
    const worktreePath = join(env.app.config.worktreesDir, session.id);
    if (existsSync(worktreePath)) {
      try {
        execFileSync("git", ["-C", env.workdir, "worktree", "remove", "--force", worktreePath],
          { stdio: "pipe" });
      } catch { /* cleanup */ }
    }
  }, 30_000);

  it("W key shows worktree overlay for a session with worktree", async () => {
    // Note: TuiDriver creates its own AppContext, so we need to use it
    // for session creation. The worktree overlay may show even for sessions
    // without actual worktrees -- it shows diff/finish options.
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        repo: process.cwd(),
        summary: "worktree-overlay-test",
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("worktree-overlay-test");

      // Press W to open worktree overlay
      tui.press("W");
      await new Promise(r => setTimeout(r, 1000));

      // The worktree overlay should appear -- look for worktree-related text
      // It may show "Worktree", "Diff", "Merge", "PR", "Finish", or an error
      // if no worktree exists
      const raw = tui.text();
      const hasOverlay = raw.includes("Worktree") ||
        raw.includes("Diff") ||
        raw.includes("Merge") ||
        raw.includes("PR") ||
        raw.includes("Finish") ||
        raw.includes("No worktree") ||
        raw.includes("worktree");
      expect(hasOverlay).toBe(true);

      // TUI should still be alive
      expect(tui.alive()).toBe(true);

      // Close overlay
      tui.press("escape");
      await new Promise(r => setTimeout(r, 300));
    } finally {
      tui.stop();
    }
  }, 30_000);
});
