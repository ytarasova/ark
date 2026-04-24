/**
 * for_each + mode:inline orchestration loop.
 *
 * For each item in the resolved list, runs every sub-stage in `stageDef.stages`
 * sequentially IN THE PARENT SESSION. No child sessions are created; the parent's
 * worktree is reused for all sub-stages. The caller provides a DispatchInlineSubStageCb
 * so this module does not import the full agent-dispatch pipeline.
 */

import type { DispatchDeps, DispatchResult } from "../types.js";
import type { StageDefinition } from "../../../state/flow.js";
import { logDebug, logWarn } from "../../../observability/structured-log.js";

import { sumPriorIterationCosts } from "./budget.js";
import { writeCheckpoint, clearCheckpoint } from "./checkpoint.js";
import { buildIterationVars, substituteStageTemplates } from "./iteration-vars.js";
import { prepareForEachLoop, emitEmptyListComplete, enforceBudgetCap, emitLoopStart } from "./orchestration.js";

export type InlineDeps = Pick<DispatchDeps, "sessions" | "events">;

/**
 * Callback for dispatching a single inline sub-stage against the parent
 * session's worktree. Implemented by CoreDispatcher and injected via
 * ForEachDispatcher's constructor so this module does not depend on the
 * full agent-dispatch pipeline.
 */
export interface DispatchInlineSubStageCb {
  (sessionId: string, resolvedSubStage: StageDefinition, iterVars: Record<string, string>): Promise<DispatchResult>;
}

/**
 * Execute a `for_each + mode:inline` stage.
 *
 * Steps per iteration:
 *   1. Check for an existing checkpoint (resume mode) or resolve the list fresh.
 *   2. Write loop-enter checkpoint before first iteration.
 *   3. Build iteration vars (base session vars + flattened iteration item).
 *   4. Write in_flight checkpoint before dispatching each iteration.
 *   5. For each sub-stage: substitute templates + dispatch via callback.
 *   6. Clear in_flight after iteration terminal.
 *   7. Apply on_iteration_failure policy on failure.
 *   8. Clear checkpoint on loop exit.
 */
export async function dispatchForEachInline(
  deps: InlineDeps,
  dispatchSubStage: DispatchInlineSubStageCb | undefined,
  sessionId: string,
  stageDef: StageDefinition,
  sessionVars: Record<string, string>,
): Promise<DispatchResult> {
  if (!dispatchSubStage) {
    return { ok: false, message: "mode:inline requires dispatchInlineSubStage callback -- not wired" };
  }

  const session = await deps.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const forEachExpr = stageDef.for_each!;
  const iterVar = stageDef.iteration_var ?? "item";
  const onIterFailure = stageDef.on_iteration_failure ?? "stop";
  const subStages = stageDef.stages ?? [];

  if (subStages.length === 0) {
    return { ok: false, message: `Stage '${stageDef.name}' has mode:inline but no stages defined` };
  }

  const prep = prepareForEachLoop(
    session as unknown as Record<string, unknown>,
    stageDef.name,
    forEachExpr,
    sessionVars,
    "for_each inline",
    sessionId,
  );
  if (!prep.ok) return prep;
  const { items, isResume, existingCp } = prep.prepared;

  if (items.length === 0) {
    return emitEmptyListComplete(deps, sessionId, session.stage);
  }

  if (!isResume) {
    await emitLoopStart(deps, sessionId, session.stage, stageDef.name, items, {
      total: items.length,
      mode: "inline",
      iterVar,
      subStageCount: subStages.length,
    });
  }

  let succeeded = 0;
  let failedCount = 0;

  // Cumulative budget cap set on the session (via session.config.max_budget_usd).
  const sessionCap = (session.config?.max_budget_usd as number | undefined) ?? null;

  // In resume mode, determine which iterations are already done.
  // For inline mode there are no child sessions, so we use next_index as the
  // authoritative "already started" pointer. Iterations before next_index that
  // completed successfully are counted as succeeded; the one at next_index-1
  // might have been interrupted mid-sub-stage and is rerun from scratch.
  const resumeStartIndex = isResume && existingCp ? Math.max(0, existingCp.next_index - 1) : 0;
  const priorSucceeded = isResume ? resumeStartIndex : 0;
  succeeded = priorSucceeded;

  for (let i = isResume ? resumeStartIndex : 0; i < items.length; i++) {
    // -- Cumulative budget check (before dispatching next iteration) --
    const budgetBreach = await enforceBudgetCap(deps, sessionId, session.stage, i, sessionCap, []);
    if (budgetBreach) return budgetBreach;

    const item = items[i];
    const iterVars = buildIterationVars(sessionVars, iterVar, item);

    // Record start time for per-iteration duration tracking.
    const inlineIterStartMs = Date.now();
    // Snapshot current cumulative cost so we can compute per-iteration delta.
    const costBeforeIter = await sumPriorIterationCosts(deps.events, sessionId);

    // Write in_flight checkpoint before this iteration's sub-stages.
    await writeCheckpoint(deps.sessions, sessionId, {
      stage_name: stageDef.name,
      total_items: items.length,
      items,
      next_index: i + 1,
      in_flight: {
        index: i,
        sub_stage_name: subStages[0]?.name,
        started_at: new Date().toISOString(),
      },
    });

    await deps.events.log(sessionId, "for_each_iteration_start", {
      stage: session.stage,
      actor: "system",
      data: { index: i, item: JSON.stringify(item), mode: "inline" },
    });

    let iterationFailed = false;

    for (const subStage of subStages) {
      // Substitute iteration vars into all string fields of the sub-stage.
      // Propagate stage-level max_budget_usd to the resolved sub-stage if the
      // sub-stage's inline agent does not already declare its own budget.
      const resolvedSubStage = substituteStageTemplates(subStage, iterVars);
      if (
        stageDef.max_budget_usd !== undefined &&
        resolvedSubStage.agent &&
        typeof resolvedSubStage.agent === "object"
      ) {
        if ((resolvedSubStage.agent as { max_budget_usd?: number }).max_budget_usd === undefined) {
          (resolvedSubStage.agent as { max_budget_usd?: number }).max_budget_usd = stageDef.max_budget_usd;
        }
      }

      const subResult = await dispatchSubStage(sessionId, resolvedSubStage, iterVars);

      if (!subResult.ok) {
        iterationFailed = true;
        await deps.events.log(sessionId, "for_each_iteration_failed", {
          stage: session.stage,
          actor: "system",
          data: { index: i, subStage: subStage.name, reason: subResult.message },
        });
        logWarn("session", `for_each inline iteration ${i} sub-stage '${subStage.name}' failed`, {
          sessionId,
          iteration: i,
          subStage: subStage.name,
        });
        break; // Stop sub-stages for this iteration on first failure
      }

      await deps.events.log(sessionId, "for_each_substage_complete", {
        stage: session.stage,
        actor: "system",
        data: { index: i, subStage: subStage.name },
      });
    }

    const inlineIterDurationMs = Date.now() - inlineIterStartMs;
    // Compute cost delta for this iteration using timestamp-window approximation.
    // Note: this can over-count if cost events from other sources overlap the window.
    const costAfterIter = await sumPriorIterationCosts(deps.events, sessionId);
    const inlineIterCostUsd = Math.max(0, costAfterIter - costBeforeIter);

    // Clear in_flight after iteration terminal (success or failure).
    await writeCheckpoint(deps.sessions, sessionId, {
      stage_name: stageDef.name,
      total_items: items.length,
      items,
      next_index: i + 1,
    });

    if (iterationFailed) {
      failedCount++;
      if (onIterFailure === "stop") {
        await clearCheckpoint(deps.sessions, sessionId);
        return {
          ok: false,
          message: `for_each inline: iteration ${i} failed -- stopping`,
        };
      }
      continue;
    }

    succeeded++;
    await deps.events.log(sessionId, "for_each_iteration_complete", {
      stage: session.stage,
      actor: "system",
      data: {
        index: i,
        mode: "inline",
        exit_status: "completed",
        duration_ms: inlineIterDurationMs,
        cost_usd: inlineIterCostUsd,
      },
    });
    logDebug("session", `for_each inline iteration ${i}: complete`, { sessionId });
  }

  // All iterations done -- clear the checkpoint.
  await clearCheckpoint(deps.sessions, sessionId);

  await deps.events.log(sessionId, "for_each_complete", {
    stage: session.stage,
    actor: "system",
    data: { total: items.length, succeeded, failed: failedCount, mode: "inline" },
  });

  return {
    ok: true,
    message: `for_each inline: ${items.length} iterations complete (${succeeded} succeeded, ${failedCount} failed)`,
  };
}
