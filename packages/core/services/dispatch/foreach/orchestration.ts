/**
 * Shared for_each orchestration helpers used by both spawn and inline modes.
 *
 * Both modes share a common preamble (resume-or-fresh decision, empty-list
 * short-circuit, loop-enter checkpoint) and a cumulative-budget check before
 * each iteration. Keeping these here trims the per-mode orchestrators to the
 * actually-different bodies (child spawn vs sub-stage dispatch).
 */

import type { DispatchDeps, DispatchResult } from "../types.js";
import type { ForEachCheckpoint } from "../../../state/flow.js";
import { logInfo } from "../../../observability/structured-log.js";

import { sumPriorIterationCosts } from "./budget.js";
import { writeCheckpoint, clearCheckpoint } from "./checkpoint.js";
import { resolveForEachList } from "./list-resolve.js";

export interface PreparedLoop {
  /** Items resolved from the for_each expression (or from checkpoint on resume). */
  items: unknown[];
  /** True when an existing checkpoint matched this stage. */
  isResume: boolean;
  /** The existing checkpoint if in resume mode (never undefined when isResume). */
  existingCp: ForEachCheckpoint | null;
}

/**
 * Produce the items list + resume flag for a for_each stage. On fresh starts
 * the list is resolved from session vars + config; on resume the checkpoint's
 * captured list is reused verbatim.
 */
export function prepareForEachLoop(
  session: Record<string, unknown>,
  stageName: string,
  forEachExpr: string,
  sessionVars: Record<string, unknown>,
  logPrefix: string,
  sessionId: string,
): { ok: true; prepared: PreparedLoop } | { ok: false; message: string } {
  const existingCp =
    ((session.config as Record<string, unknown> | null)?.for_each_checkpoint as ForEachCheckpoint | null | undefined) ??
    null;
  const isResume = existingCp != null && existingCp.stage_name === stageName;

  let items: unknown[];
  if (isResume) {
    items = existingCp.items;
    logInfo("session", `${logPrefix}: resuming stage '${stageName}' from checkpoint`, {
      sessionId,
      total: items.length,
      next_index: existingCp.next_index,
    });
  } else {
    try {
      items = resolveForEachList(forEachExpr, sessionVars, session);
    } catch (err: any) {
      return { ok: false, message: `for_each: failed to resolve list: ${err.message}` };
    }
  }

  return { ok: true, prepared: { items, isResume, existingCp: isResume ? existingCp : null } };
}

/**
 * Handle the empty-list case: emit a for_each_complete event with zero-count
 * totals and clear any checkpoint. Returns a DispatchResult the caller can
 * return directly.
 */
export async function emitEmptyListComplete(
  deps: Pick<DispatchDeps, "sessions" | "events">,
  sessionId: string,
  stage: string | null,
): Promise<DispatchResult> {
  await deps.events.log(sessionId, "for_each_complete", {
    stage,
    actor: "system",
    data: { total: 0, succeeded: 0, failed: 0, note: "empty list -- no iterations" },
  });
  await clearCheckpoint(deps.sessions, sessionId);
  return {
    ok: true,
    launched: false,
    reason: "for_each_empty_list",
    message: "for_each: empty list -- stage complete",
  };
}

/**
 * Check cumulative spend against `sessionCap`. If exceeded, mark the session
 * failed, clear the checkpoint, emit a for_each_budget_exceeded event, and
 * return a DispatchResult describing the failure. Returns `null` when the
 * cap is either null or not yet reached (the caller should proceed).
 */
export async function enforceBudgetCap(
  deps: Pick<DispatchDeps, "sessions" | "events">,
  sessionId: string,
  stage: string | null,
  iterationIndex: number,
  sessionCap: number | null,
  spawnedChildIds: string[],
): Promise<DispatchResult | null> {
  if (sessionCap === null) return null;
  const cumulative = await sumPriorIterationCosts(deps.events, sessionId, spawnedChildIds);
  if (cumulative < sessionCap) return null;

  await deps.events.log(sessionId, "for_each_budget_exceeded", {
    stage,
    actor: "system",
    data: { cumulative_cost_usd: cumulative, cap_usd: sessionCap, next_iteration: iterationIndex },
  });
  await deps.sessions.update(sessionId, {
    status: "failed",
    error: `budget exceeded: $${cumulative.toFixed(4)} >= cap $${sessionCap}`,
  });
  await clearCheckpoint(deps.sessions, sessionId);
  return {
    ok: false,
    message: `for_each: budget exceeded at iteration ${iterationIndex}: $${cumulative.toFixed(4)} >= cap $${sessionCap}`,
  };
}

/**
 * Write the loop-enter checkpoint and emit a for_each_start event. Called
 * only on fresh (non-resume) starts. Kept here so both spawn and inline
 * modes follow the same "checkpoint-before-event" ordering.
 */
export async function emitLoopStart(
  deps: Pick<DispatchDeps, "sessions" | "events">,
  sessionId: string,
  stage: string | null,
  stageName: string,
  items: unknown[],
  eventData: Record<string, unknown>,
): Promise<void> {
  await writeCheckpoint(deps.sessions, sessionId, {
    stage_name: stageName,
    total_items: items.length,
    items,
    next_index: 0,
  });
  await deps.events.log(sessionId, "for_each_start", {
    stage,
    actor: "system",
    data: eventData,
  });
}
