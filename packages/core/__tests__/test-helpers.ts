/**
 * Shared test context helper — eliminates boilerplate for beforeEach/afterAll
 * context setup across core test files.
 *
 * Usage:
 *   import { withTestContext } from "./test-helpers.js";
 *   withTestContext();
 *
 *   import { waitFor } from "./test-helpers.js";
 *   await waitFor(() => someCondition());
 */

import { beforeEach, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { AppContext, setApp, clearApp } from "../app.js";
import type { Session, SessionStatus, Compute, ComputeProviderName, ComputeStatus } from "../../types/index.js";

/**
 * Snapshot current ark-* tmux sessions. Call before tests start, then pass
 * the result to killNewArkTmuxSessions() in afterAll to clean up only
 * sessions created during the test run (avoids destroying real sessions).
 */
export function snapshotArkTmuxSessions(): Set<string> {
  try {
    const result = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new Set(result.split("\n").filter((s) => s.startsWith("ark-s-")));
  } catch {
    return new Set();
  }
}

/**
 * Kill ark-* tmux sessions that were NOT in the pre-test snapshot.
 * Also kills child processes (claude, bun) inside each session before
 * destroying it, preventing orphaned claude instances.
 * Safe to call in afterAll - won't destroy the user's real sessions.
 */
export function killNewArkTmuxSessions(preExisting: Set<string>): void {
  try {
    const result = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const current = result.split("\n").filter((s) => s.startsWith("ark-s-"));
    for (const name of current) {
      if (!preExisting.has(name)) {
        // Kill child processes inside the tmux session first
        try {
          const panes = execFileSync("tmux", ["list-panes", "-t", name, "-F", "#{pane_pid}"], {
            encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
          });
          for (const pid of panes.split("\n").filter(Boolean)) {
            try { execFileSync("pkill", ["-9", "-P", pid], { stdio: "pipe" }); } catch { /* process may already be dead */ }
            try { process.kill(parseInt(pid), 9); } catch { /* process may already be dead */ }
          }
        } catch { /* pane listing may fail */ }
        // Then kill the tmux session
        try { execFileSync("tmux", ["kill-session", "-t", name], { stdio: "pipe" }); } catch { /* session may already be dead */ }
      }
    }
  } catch {
    // No tmux server or no sessions - fine
  }
}

/**
 * Sets up beforeEach/afterAll hooks for test context isolation.
 * Each test gets a fresh AppContext.forTest() with an isolated temp DB.
 * Automatically cleans up sessions and their processes on teardown.
 */
export function withTestContext(): { getCtx: () => AppContext } {
  let app: AppContext;
  let tmuxSnapshot: Set<string>;

  beforeEach(async () => {
    if (app) {
      await cleanupTestSessions(app);
      await app.shutdown();
      clearApp();
    }
    tmuxSnapshot = snapshotArkTmuxSessions();
    app = AppContext.forTest();
    setApp(app);
    await app.boot();
  });

  afterAll(async () => {
    if (app) {
      await cleanupTestSessions(app);
      await app.shutdown();
      clearApp();
    }
    // Safety net: also kill any tmux sessions created during this test
    // that might not be tracked in the DB (e.g. if dispatch failed mid-way)
    if (tmuxSnapshot) killNewArkTmuxSessions(tmuxSnapshot);
  });

  return { getCtx: () => app };
}

/**
 * Clean up all sessions owned by this AppContext through the proper service layer.
 * Uses SessionService.stopAll() which delegates to the compute provider for each
 * session -- the provider knows how to kill tmux, Docker, EC2, etc.
 */
export async function cleanupTestSessions(app: AppContext): Promise<void> {
  try {
    await app.sessionService.stopAll();
  } catch {
    // DB may already be closed or service not booted
  }
}

/**
 * Create a mock Session with sensible defaults. Override any field.
 * All required fields have defaults so tests don't need to spell them out.
 */
export function mockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s-test01",
    ticket: null,
    summary: null,
    repo: null,
    branch: null,
    compute_name: null,
    session_id: null,
    claude_session_id: null,
    stage: null,
    status: "pending" as SessionStatus,
    flow: "default",
    agent: null,
    workdir: null,
    pr_url: null,
    pr_id: null,
    error: null,
    parent_id: null,
    fork_group: null,
    group_name: null,
    breakpoint_reason: null,
    attached_by: null,
    config: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock Compute with sensible defaults. Override any field.
 */
export function mockCompute(overrides: Partial<Compute> & { name?: string } = {}): Compute {
  return {
    name: "test-compute",
    provider: "local" as ComputeProviderName,
    status: "running" as ComputeStatus,
    config: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Poll a condition until it's true or timeout. Better than arbitrary setTimeout. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  opts?: { timeout?: number; interval?: number; message?: string }
): Promise<void> {
  const timeout = opts?.timeout ?? 5000;
  const interval = opts?.interval ?? 50;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(opts?.message ?? `waitFor timed out after ${timeout}ms`);
}
