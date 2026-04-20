/**
 * Shared test context helper -- eliminates boilerplate for beforeEach/afterAll
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
import { AppContext } from "../app.js";
import type { Session, SessionStatus, Compute, ComputeProviderName, ComputeStatus } from "../../types/index.js";

/**
 * Assert that no AgentHandle is still registered on `app`. Used by tests
 * that want to verify the lifecycle machinery reaped everything. Replaces
 * the retired `snapshotArkTmuxSessions`/`killNewArkTmuxSessions` helpers,
 * which raced under `--concurrency 4` and mass-killed processes belonging
 * to other workers.
 *
 * Prefer this over poking tmux directly: the registry is the authoritative
 * source of truth, and matches what `AppContext.shutdown()` drains.
 */
export function expectNoLiveSessions(app: AppContext): void {
  const live = app.agentRegistry.sessionIds();
  if (live.length > 0) {
    throw new Error(`Expected 0 live AgentHandles, found ${live.length}: ${live.join(", ")}`);
  }
}

/**
 * Count ark-* tmux sessions still alive process-wide. Used only by the
 * anti-regression stress test -- regular tests should never need this.
 * Lives here (not in infra/tmux.ts) because it's a test-only escape hatch.
 */
export function countLiveArkTmuxSessions(): number {
  try {
    const result = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.split("\n").filter((s) => s.startsWith("ark-s-")).length;
  } catch {
    return 0;
  }
}

/**
 * Test-local AppContext handle. Kept in the test helpers module (NOT in
 * production code) so tests that used the old `getApp()` service locator
 * can migrate with a single import change. Production code must receive
 * AppContext via constructor/parameter injection -- there is no
 * `getApp()` exported from packages/core/app.ts anymore.
 */
let _currentTestApp: AppContext | null = null;

/** Read the test-scoped AppContext. Throws if `withTestContext()` hasn't initialized one yet. */
export function getApp(): AppContext {
  if (!_currentTestApp) {
    throw new Error("getApp() (test) called before the AppContext was initialized -- did you call withTestContext()?");
  }
  return _currentTestApp;
}

/** Install an AppContext as the current test context (used by ad-hoc beforeAll setups). */
export function setApp(app: AppContext): void {
  _currentTestApp = app;
}

/** Clear the test-scoped AppContext (teardown). */
export function clearApp(): void {
  _currentTestApp = null;
}

/**
 * Sets up beforeEach/afterAll hooks for test context isolation.
 * Each test gets a fresh AppContext.forTestAsync() with an isolated temp DB.
 * Automatically cleans up sessions and their processes on teardown via
 * `AppContext.shutdown()`, which drains the AgentRegistry (every live
 * tmux session is reaped by its AgentHandle -- no snapshot-and-kill
 * races across parallel workers).
 */
export function withTestContext(): { getCtx: () => AppContext } {
  let app: AppContext;

  beforeEach(async () => {
    if (app) {
      await cleanupTestSessions(app);
      await app.shutdown();
      _currentTestApp = null;
    }
    app = await AppContext.forTestAsync();
    await app.boot();
    _currentTestApp = app;
  });

  afterAll(async () => {
    if (app) {
      await cleanupTestSessions(app);
      await app.shutdown();
      _currentTestApp = null;
    }
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
  opts?: { timeout?: number; interval?: number; message?: string },
): Promise<void> {
  const timeout = opts?.timeout ?? 5000;
  const interval = opts?.interval ?? 50;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(opts?.message ?? `waitFor timed out after ${timeout}ms`);
}
