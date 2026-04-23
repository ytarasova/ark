/**
 * Session cleanup helper -- removes external state when a session reaches a
 * terminal state (completed, failed, stopped).
 *
 * Design decisions:
 * - Does NOT remove the session row, transcript.jsonl, or event log; those
 *   stay for post-mortem and cost attribution.
 * - Safe to call multiple times -- idempotent via a `session_cleaned` event
 *   guard so a double-call is a no-op.
 * - If worktree removal fails we log a `session_cleanup_failed` event and
 *   continue; the `session_cleaned` event is still emitted so the guard
 *   prevents re-running a broken cleanup repeatedly.
 */

import { existsSync } from "fs";

import type { AppContext } from "../../app.js";
import type { Session } from "../../../types/index.js";
import { logDebug, logError } from "../../observability/structured-log.js";

/**
 * Clean up external state for a session that has reached a terminal state.
 *
 * - Removes the worktree (if one was allocated and still exists on disk).
 * - Emits a `session_cleaned` event for audit.
 * - Does NOT remove the session row, transcript.jsonl, or event log.
 *
 * Safe to call multiple times; idempotent after the first `session_cleaned`
 * event is emitted.
 */
export async function cleanupSession(app: AppContext, session: Session): Promise<void> {
  const sessionId = session.id;

  // Idempotency: if we already emitted session_cleaned, skip.
  try {
    const existingEvents = await app.events.list(sessionId, { type: "session_cleaned", limit: 1 });
    if (existingEvents.length > 0) {
      logDebug("session-cleanup", `session ${sessionId} already cleaned up, skipping`);
      return;
    }
  } catch (err: any) {
    // If we can't read events (e.g. db closed), log and bail gracefully.
    logError("session-cleanup", `session ${sessionId}: could not check existing events: ${err?.message ?? err}`);
    return;
  }

  // Determine worktree path. The session worktree lives under app.config.dirs.worktrees/<sessionId>.
  // We check there first, then fall back to session.workdir if it looks like a worktree.
  const worktreePath = buildWorktreePath(app, session);
  let worktreeRemoved = false;

  if (worktreePath && existsSync(worktreePath)) {
    try {
      const { removeSessionWorktree } = await import("../worktree/setup.js");
      await removeSessionWorktree(app, session);
      worktreeRemoved = true;
      logDebug("session-cleanup", `session ${sessionId}: worktree removed at ${worktreePath}`);
    } catch (err: any) {
      logError("session-cleanup", `session ${sessionId}: worktree removal failed: ${err?.message ?? err}`);
      await app.events.log(sessionId, "session_cleanup_failed", {
        actor: "system",
        data: {
          step: "worktree_remove",
          path: worktreePath,
          error: String(err?.message ?? err),
        },
      });
    }
  } else if (worktreePath) {
    logDebug("session-cleanup", `session ${sessionId}: worktree path ${worktreePath} does not exist, skipping removal`);
  }

  await app.events.log(sessionId, "session_cleaned", {
    actor: "system",
    data: {
      worktree_path: worktreePath,
      worktree_removed: worktreeRemoved,
    },
  });

  logDebug("session-cleanup", `session ${sessionId}: cleanup complete (worktree_removed=${worktreeRemoved})`);
}

/**
 * Derive the expected worktree path for a session.
 * The canonical location is <worktreesDir>/<sessionId>, which is where
 * `setupSessionWorktree` places it. Returns null if we cannot determine
 * a meaningful path.
 */
function buildWorktreePath(app: AppContext, session: Session): string | null {
  const candidate = `${app.config.dirs.worktrees}/${session.id}`;
  if (existsSync(candidate)) return candidate;
  // No standard worktree dir -- nothing to clean up at the worktree level.
  return null;
}
