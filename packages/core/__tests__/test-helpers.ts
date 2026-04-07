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
        try { execFileSync("tmux", ["kill-session", "-t", name], { stdio: "pipe" }); } catch { /* already gone */ }
      }
    }
  } catch {
    // No tmux server or no sessions - fine
  }
}

/**
 * Sets up beforeEach/afterAll hooks for test context isolation.
 * Each test gets a fresh AppContext.forTest() with an isolated temp DB.
 */
export function withTestContext(): { getCtx: () => AppContext } {
  let app: AppContext;

  beforeEach(async () => {
    if (app) { await app.shutdown(); clearApp(); }
    app = AppContext.forTest();
    setApp(app);
    await app.boot();
  });

  afterAll(async () => {
    if (app) { await app.shutdown(); clearApp(); }
  });

  return { getCtx: () => app };
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
