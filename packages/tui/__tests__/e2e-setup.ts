/**
 * Shared E2E test setup — full isolation from production state.
 *
 * Provides:
 * - Isolated DB via AppContext.forTest() (temp dir, not ~/.ark)
 * - Isolated workdir (temp dir, not cwd — hooks config won't touch real repo)
 * - AppContext with providers (fixes "AppContext not initialized" errors)
 * - Tmux cleanup on teardown
 *
 * Usage:
 *   const env = await setupE2E();
 *   afterAll(() => env.teardown());
 *   // env.workdir — temp dir for repo/workdir
 *   // env.app — booted AppContext
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import * as tmux from "../../core/tmux.js";

export interface E2EEnv {
  app: AppContext;
  /** Isolated temp workdir — use instead of process.cwd() */
  workdir: string;
  /** Track tmux sessions for cleanup */
  tmuxSessions: string[];
  /** Track session IDs for cleanup */
  sessionIds: string[];
  /** Tear everything down */
  teardown: () => Promise<void>;
}

/**
 * Boot a fully isolated E2E environment.
 * Call teardown() in afterAll.
 */
export async function setupE2E(): Promise<E2EEnv> {
  // 1. Create AppContext with isolated temp dir
  const app = AppContext.forTest();
  setApp(app);
  await app.boot();

  // 2. Create isolated workdir with a git repo (some tests need .git)
  const workdir = mkdtempSync(join(tmpdir(), "ark-e2e-repo-"));
  try {
    execFileSync("git", ["init", workdir], { stdio: "pipe" });
    // Create initial commit so git operations work
    writeFileSync(join(workdir, ".gitkeep"), "");
    execFileSync("git", ["-C", workdir, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", workdir, "commit", "-m", "init", "--allow-empty"], { stdio: "pipe" });
  } catch {
    // git init failed — workdir still usable for non-git tests
  }

  const env: E2EEnv = {
    app,
    workdir,
    tmuxSessions: [],
    sessionIds: [],
    teardown: async () => {
      // Kill all test tmux sessions
      for (const name of env.tmuxSessions) {
        try { tmux.killSession(name); } catch {}
      }

      // Shutdown AppContext (closes DB, removes temp dir)
      await app.shutdown();
      clearApp();

      // Clean up workdir
      try {
        const { rmSync } = await import("fs");
        rmSync(workdir, { recursive: true, force: true });
      } catch {}

      // Prune any leaked worktrees pointing to our temp dir
      try {
        execFileSync("git", ["worktree", "prune"], { stdio: "pipe", cwd: process.cwd() });
      } catch {}
    },
  };

  return env;
}
