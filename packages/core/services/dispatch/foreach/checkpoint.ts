/**
 * for_each checkpoint persistence helpers.
 *
 * Durability (P3.2): each iteration writes a ForEachCheckpoint into
 * session.config.for_each_checkpoint before dispatching. On daemon restart,
 * boot reconciliation re-dispatches sessions carrying a checkpoint and the
 * dispatcher resumes from the recorded position.
 *
 * For spawn mode the "already completed" set is derived from live child session
 * statuses rather than from checkpoint.completed -- robust against the crash
 * window between a child's SessionEnd hook and the parent's checkpoint update.
 */

import type { DispatchDeps } from "../types.js";
import type { ForEachCheckpoint } from "../../flow.js";

/**
 * Write (or update) the for_each checkpoint on the session config.
 * This is always an await-before-side-effect write -- we persist the intent
 * before we actually dispatch the iteration.
 */
export async function writeCheckpoint(
  sessions: Pick<DispatchDeps["sessions"], "mergeConfig">,
  sessionId: string,
  checkpoint: ForEachCheckpoint,
): Promise<void> {
  await sessions.mergeConfig(sessionId, { for_each_checkpoint: checkpoint } as any);
}

/**
 * Clear the for_each checkpoint from session config (called when the loop exits
 * -- either all iterations complete or on_iteration_failure halts the loop).
 */
export async function clearCheckpoint(
  sessions: Pick<DispatchDeps["sessions"], "mergeConfig">,
  sessionId: string,
): Promise<void> {
  // mergeConfig shallow-merges, so set to null to clear.
  await sessions.mergeConfig(sessionId, { for_each_checkpoint: null } as any);
}

/**
 * Build the set of already-completed iteration indices for a spawn-mode loop
 * by scanning child sessions directly.
 *
 * We look at all children with config.for_each_parent==parentId and
 * config.for_each_index set to a number. A child whose status is "completed"
 * is counted as done. This is more robust than reading checkpoint.completed
 * because a daemon crash between the child's SessionEnd hook and the parent's
 * checkpoint update would leave the checkpoint stale, but the child's status
 * row is durable.
 */
export async function buildCompletedSetFromChildren(
  sessions: Pick<DispatchDeps["sessions"], "list">,
  parentId: string,
): Promise<Set<number>> {
  const { done } = await buildCompletedStateFromChildren(sessions, parentId);
  return done;
}

/**
 * Like `buildCompletedSetFromChildren` but also returns the IDs of every
 * completed prior child. Callers resuming a for_each spawn loop need both:
 *   - the index set to skip already-done iterations
 *   - the child IDs so the running cumulative cost check can sum across
 *     their SessionEnd hook_status events (budget-on-resume regression).
 */
export async function buildCompletedStateFromChildren(
  sessions: Pick<DispatchDeps["sessions"], "list">,
  parentId: string,
): Promise<{ done: Set<number>; childIds: string[] }> {
  const children = await sessions.list({ parent_id: parentId, limit: 500 } as any);
  const done = new Set<number>();
  const childIds: string[] = [];
  for (const child of children) {
    const cfg = child.config as Record<string, unknown> | null;
    if (!cfg) continue;
    const idx = cfg.for_each_index;
    if (typeof idx !== "number") continue;
    if (child.status === "completed") {
      done.add(idx);
      childIds.push(child.id);
    }
  }
  return { done, childIds };
}
