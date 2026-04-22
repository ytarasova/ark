/**
 * Orphan PID sweeper.
 *
 * Scans for sessions stuck in `running` state whose backing process has died.
 * Transitions orphans to `failed` with reason `orphaned` and triggers cleanup.
 *
 * Designed to run every 5 minutes from AppContext.boot(). Tests that want to
 * exercise the sweeper call sweepOrphans(app) directly -- the sweeper is NOT
 * registered as a setInterval in the test profile to avoid sporadic test
 * interference.
 *
 * Process liveness: uses `executor.status(handle)` where possible. The handle
 * is stored in `session.session_id` (the field used by all executors -- both
 * tmux and agent-sdk). The executor name is stored in `session.config.launch_executor`.
 * Sessions with neither field are treated as orphaned immediately.
 */

import type { AppContext } from "../../app.js";
import { cleanupSession } from "./cleanup.js";
import { logDebug, logError, logInfo } from "../../observability/structured-log.js";
import { getExecutor } from "../../executor.js";

/**
 * Scan for sessions stuck in `running` state whose backing process has died.
 * Transition orphans to `failed` with reason `orphaned` and clean up.
 *
 * Returns the number of sessions checked and the number marked orphaned.
 */
export async function sweepOrphans(app: AppContext): Promise<{ checked: number; orphaned: number }> {
  let runningSessions;
  try {
    runningSessions = await app.sessions.list({ status: "running" });
  } catch (err: any) {
    logError("orphan-sweeper", `failed to list running sessions: ${err?.message ?? err}`);
    return { checked: 0, orphaned: 0 };
  }

  let orphaned = 0;

  for (const s of runningSessions) {
    try {
      const isOrphan = await isSessionOrphaned(app, s);
      if (!isOrphan) continue;

      logInfo("orphan-sweeper", `session ${s.id} has no live process -- marking failed (orphaned)`);

      await app.sessions.update(s.id, {
        status: "failed",
        error: "orphaned: backing process is no longer alive",
        session_id: null,
      });

      await app.events.log(s.id, "session_orphaned", {
        actor: "system",
        data: {
          reason: "process_not_alive",
          handle: s.session_id ?? null,
          executor: (s.config?.launch_executor as string | undefined) ?? null,
        },
      });

      // Fetch refreshed session row for cleanup (status is now failed).
      const refreshed = await app.sessions.get(s.id);
      if (refreshed) {
        await cleanupSession(app, refreshed);
      }

      orphaned++;
    } catch (err: any) {
      logError("orphan-sweeper", `error processing session ${s.id}: ${err?.message ?? err}`);
    }
  }

  logDebug("orphan-sweeper", `sweep complete: checked ${runningSessions.length}, orphaned ${orphaned}`);
  return { checked: runningSessions.length, orphaned };
}

/**
 * Check whether a running session's backing process is still alive.
 * Returns true when the session is an orphan (process dead or untrackable).
 */
async function isSessionOrphaned(
  app: AppContext,
  session: { id: string; session_id: string | null; config?: Record<string, unknown> },
): Promise<boolean> {
  const handle = session.session_id ?? null;

  // No handle at all -- session marked running but was never dispatched or
  // handle was already cleared. Treat as orphan.
  if (!handle) {
    return true;
  }

  // Determine which executor owns this handle.
  const executorName = (session.config?.launch_executor as string | undefined) ?? null;

  // Try the plugin registry first (it shadows the global registry for DI).
  const executor =
    (executorName ? (app.pluginRegistry.executor(executorName) ?? getExecutor(executorName)) : null) ??
    // No executor name stored: iterate all known executors and check if any
    // recognises the handle (handles are prefixed: sdk-<id>, ark-<id>, etc.).
    resolveExecutorByHandle(app, handle);

  if (!executor) {
    // Unknown executor -- handle may belong to a pre-dispatch or legacy row.
    // We only mark as orphaned if the handle prefix is recognisable; otherwise
    // leave it alone to avoid falsely killing valid sessions.
    return handleLooksAbandoned(handle);
  }

  try {
    const status = await executor.status(handle);
    // "running" means the process is alive -- leave the session alone.
    if (status.state === "running" || status.state === "idle") return false;
    // "not_found": the executor has no record of this handle (process already
    // cleaned up from the registry). Treat as dead.
    return true;
  } catch {
    // If status() throws, assume alive to avoid false positives.
    return false;
  }
}

/**
 * Try to find an executor that might own the given handle based on handle
 * prefix conventions (sdk-*, ark-*, sp-*, noop-*).
 */
function resolveExecutorByHandle(app: AppContext, handle: string): import("../../executor.js").Executor | null {
  const prefix = handle.split("-")[0];
  const nameMap: Record<string, string> = {
    sdk: "agent-sdk",
    ark: "claude-code",
    sp: "subprocess",
    noop: "noop",
  };
  const executorName = nameMap[prefix];
  if (!executorName) return null;
  return app.pluginRegistry.executor(executorName) ?? getExecutor(executorName) ?? null;
}

/**
 * Heuristic: a handle that has a recognisable executor prefix but the executor
 * has no entry for it (not_found) is treated as abandoned. Handles with no
 * known prefix (e.g. raw tmux session names for legacy rows) are left alone.
 */
function handleLooksAbandoned(handle: string): boolean {
  const knownPrefixes = ["sdk-", "ark-", "sp-", "noop-"];
  return knownPrefixes.some((p) => handle.startsWith(p));
}
