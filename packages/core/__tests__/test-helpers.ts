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
import { buildHostedAppMode } from "../modes/app-mode.js";
import type { ArkConfig } from "../config.js";

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
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          for (const pid of panes.split("\n").filter(Boolean)) {
            try {
              execFileSync("pkill", ["-9", "-P", pid], { stdio: "pipe" });
            } catch {
              /* process may already be dead */
            }
            try {
              process.kill(parseInt(pid), 9);
            } catch {
              /* process may already be dead */
            }
          }
        } catch {
          /* pane listing may fail */
        }
        // Then kill the tmux session
        try {
          execFileSync("tmux", ["kill-session", "-t", name], { stdio: "pipe" });
        } catch {
          /* session may already be dead */
        }
      }
    }
  } catch {
    // No tmux server or no sessions - fine
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
 * Automatically cleans up sessions and their processes on teardown.
 */
export function withTestContext(): { getCtx: () => AppContext } {
  let app: AppContext;
  let tmuxSnapshot: Set<string>;

  beforeEach(async () => {
    if (app) {
      await cleanupTestSessions(app);
      await app.shutdown();
      _currentTestApp = null;
    }
    tmuxSnapshot = snapshotArkTmuxSessions();
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

/**
 * Construct an AppContext that *believes* it is in hosted mode without
 * needing a real Postgres connection.
 *
 * Implementation details:
 *   1. Build the AppContext under the `test` profile (SQLite + ephemeral
 *      arkDir + the noop executor + in-memory secret store).
 *   2. Use `_setModeForTest` to install a hosted AppMode. The override is
 *      applied to the pre-boot mode cache AND queued for re-application
 *      across the placeholder->real container swap that happens inside
 *      `boot()`, so every reader -- pre-boot, mid-boot, post-boot -- sees
 *      the hosted branch.
 *
 * Pass `{ stubBlobStore: true, stubSnapshotStore: true }` to satisfy the
 * H6/H7 boot guards with throwaway stubs -- needed when the test asserts
 * something OTHER than the boot guards themselves (e.g. that the profiles
 * store is unavailable in hosted mode). Without these stubs, boot throws
 * because the production factories refuse local-disk fallback.
 *
 * Caller is responsible for `await ctx.boot()` (or NOT booting if the test
 * is asserting that boot itself throws).
 */
export interface ForHostedTestOptions extends Partial<ArkConfig> {
  /** Inject a stub LocalDiskBlobStore (under tmp) so H6 doesn't fire. */
  stubBlobStore?: boolean;
  /** Inject a stub FsSnapshotStore (under tmp) so H7 doesn't fire. */
  stubSnapshotStore?: boolean;
}

export async function forHostedTestAsync(overrides?: ForHostedTestOptions): Promise<AppContext> {
  const { stubBlobStore, stubSnapshotStore, ...rest } = overrides ?? {};
  const ctx = await AppContext.forTestAsync(rest);
  // Hosted-mode AppMode but pinned to the sqlite dialect that the test
  // SQLite DB actually uses. The hosted-mode call sites under audit branch
  // on `mode.kind === "hosted"`, NOT on `mode.database.dialect`, so this
  // hybrid is sufficient to drive the regression assertions without
  // standing up a real Postgres. The migrations capability is rebuilt for
  // sqlite so `_openDatabase` + `_initSchema` succeed against the test DB.
  const productionHosted = buildHostedAppMode({ dialect: "sqlite", url: null }, ctx.config as ArkConfig);
  const { buildMigrationsCapability } = await import("../modes/migrations-capability.js");
  const sqliteHostedMode = {
    ...productionHosted,
    migrations: buildMigrationsCapability("sqlite"),
  };
  ctx._setModeForTest(sqliteHostedMode);

  if (stubBlobStore || stubSnapshotStore) {
    const overridesForContainer: Record<string, unknown> = {};
    if (stubBlobStore) {
      const { LocalDiskBlobStore } = await import("../storage/local-disk.js");
      overridesForContainer.blobStore = new LocalDiskBlobStore(`${ctx.config.dirs.ark}/stub-blobs`);
    }
    if (stubSnapshotStore) {
      const { FsSnapshotStore } = await import("../../compute/core/snapshot-store-fs.js");
      overridesForContainer.snapshotStore = new FsSnapshotStore(`${ctx.config.dirs.ark}/stub-snapshots`);
    }
    ctx._setContainerOverridesForTest(overridesForContainer);
  }

  return ctx;
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
