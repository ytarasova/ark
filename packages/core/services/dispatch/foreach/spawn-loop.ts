/**
 * for_each + mode:spawn orchestration loop.
 *
 * Iterates a list resolved from session inputs/state and spawns one child
 * session per item sequentially. Each child is awaited (via
 * ForEachChildSpawner.waitForChild) before the next one starts.
 *
 * Durability: a ForEachCheckpoint is written before spawning each iteration
 * and cleared on loop exit. Resume is driven by child-session status scan so
 * the dispatcher is robust against a daemon crash between a child's
 * SessionEnd hook and the parent's checkpoint update (see module docstring on
 * dispatch-foreach.ts).
 */

import { randomUUID } from "crypto";

import type { DispatchDeps, DispatchResult } from "../types.js";
import type { StageDefinition } from "../../flow.js";
import { substituteVars } from "../../../template.js";
import { logDebug, logWarn } from "../../../observability/structured-log.js";

import { sumPriorIterationCosts } from "./budget.js";
import { writeCheckpoint, clearCheckpoint, buildCompletedStateFromChildren } from "./checkpoint.js";
import { buildIterationVars, substituteInputs, substituteStageTemplates } from "./iteration-vars.js";
import { ForEachChildSpawner } from "./child-spawner.js";
import { prepareForEachLoop, emitEmptyListComplete, enforceBudgetCap, emitLoopStart } from "./orchestration.js";

export type SpawnDeps = Pick<DispatchDeps, "sessions" | "events" | "flows" | "dispatchChild">;

/**
 * Execute a `for_each + mode:spawn` stage.
 *
 * Steps:
 *   1. Check for an existing checkpoint (resume mode) or resolve the list fresh.
 *   2. Write loop-enter checkpoint (durable before any iteration starts).
 *   3. For each item (sequentially):
 *      a. Skip already-completed iterations (resume mode: check child status).
 *      b. Write in_flight checkpoint before dispatching.
 *      c. Flatten item into iteration vars, substitute spawn.inputs templates.
 *      d. Create + dispatch a child session.
 *      e. Wait for child terminal state.
 *      f. Clear in_flight from checkpoint.
 *      g. Handle failure per `on_iteration_failure`.
 *   4. Clear checkpoint on loop exit.
 *   5. Return ok when the loop finishes (or stops on failure).
 */
export async function dispatchForEachSpawn(
  deps: SpawnDeps,
  childSpawner: ForEachChildSpawner,
  sessionId: string,
  stageDef: StageDefinition,
  sessionVars: Record<string, unknown>,
): Promise<DispatchResult> {
  const session = await deps.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const forEachExpr = stageDef.for_each!;
  const iterVar = stageDef.iteration_var ?? "item";
  const onIterFailure = stageDef.on_iteration_failure ?? "stop";
  const spawnSpec = stageDef.spawn;

  if (!spawnSpec) {
    return { ok: false, message: `Stage '${stageDef.name}' has for_each but no spawn spec` };
  }

  const prep = prepareForEachLoop(
    session as unknown as Record<string, unknown>,
    stageDef.name,
    forEachExpr,
    sessionVars,
    "for_each spawn",
    sessionId,
  );
  if (!prep.ok) return prep;
  const { items, isResume } = prep.prepared;

  if (items.length === 0) {
    return emitEmptyListComplete(deps, sessionId, session.stage);
  }

  const flowLabel = typeof spawnSpec.flow === "string" ? spawnSpec.flow : (spawnSpec.flow.name ?? "inline");

  if (!isResume) {
    await emitLoopStart(deps, sessionId, session.stage, stageDef.name, items, {
      total: items.length,
      flow: flowLabel,
      iterVar,
    });
  }

  // Mark the parent as running while iterations are in flight. Without this
  // the parent stays at status="ready" -- which the UI normalises to
  // "pending" / initial state -- making it look like the parent hasn't
  // started even when its child is actively working. The post-loop
  // mediateStageHandoff transitions to "completed" (or "failed").
  if (session.status !== "running") {
    // Synthetic handle: the foreach parent has no agent of its own to probe,
    // but the session_id must be non-null to satisfy the running invariant.
    await deps.sessions.update(sessionId, { status: "running", session_id: `parent-${sessionId}` });
  }

  const forkGroup = randomUUID().slice(0, 8);
  let succeeded = 0;
  let failedCount = 0;

  // Cumulative budget cap set on the session (via session.config.max_budget_usd).
  const sessionCap = (session.config?.max_budget_usd as number | undefined) ?? null;

  // In resume mode, build the set of already-completed iterations from child
  // session status (not from checkpoint.completed -- see module docstring) AND
  // preload `spawnedChildIds` with the prior completed children so the
  // cumulative budget check sees their costs on the first iteration.
  // Regression: without the preload, resume starts cumulative=$0 and can
  // overrun the cap by the pre-crash spend.
  const { done: completedSet, childIds: priorChildIds } = isResume
    ? await buildCompletedStateFromChildren(deps.sessions, sessionId)
    : { done: new Set<number>(), childIds: [] as string[] };
  const spawnedChildIds: string[] = [...priorChildIds];

  for (let i = 0; i < items.length; i++) {
    // Resume: skip iterations that are already confirmed complete.
    if (completedSet.has(i)) {
      succeeded++;
      continue;
    }

    // -- Cumulative budget check (before spawning next iteration) --
    const budgetBreach = await enforceBudgetCap(deps, sessionId, session.stage, i, sessionCap, spawnedChildIds);
    if (budgetBreach) return budgetBreach;

    const item = items[i];
    const iterVars = buildIterationVars(sessionVars, iterVar, item);
    const resolvedInputs = substituteInputs(spawnSpec.inputs, iterVars);

    // Per-iteration overrides for session-row fields (repo / branch / workdir).
    // Lets multi-repo for_each spawn each child against a different target repo
    // on its own deterministic branch.
    const resolvedRepo = spawnSpec.repo ? substituteVars(spawnSpec.repo, iterVars) : undefined;
    const resolvedBranch = spawnSpec.branch ? substituteVars(spawnSpec.branch, iterVars) : undefined;
    const resolvedWorkdir = spawnSpec.workdir ? substituteVars(spawnSpec.workdir, iterVars) : undefined;

    // Effective per-iteration cap: stage-level max_budget_usd overrides the
    // inherited session cap. This is set on the child session's config so the
    // child's own for_each (if any) also respects it.
    const iterBudget = stageDef.max_budget_usd ?? null;

    // -- Write in_flight checkpoint BEFORE spawning. --
    // next_index advances to i+1 so a restart after this write knows iteration
    // i was at least attempted.
    const currentSession = await deps.sessions.get(sessionId);
    await writeCheckpoint(deps.sessions, sessionId, {
      stage_name: stageDef.name,
      total_items: items.length,
      items,
      next_index: i + 1,
      in_flight: {
        index: i,
        started_at: new Date().toISOString(),
      },
    });

    // Substitute iteration vars into the spawn flow's stage definitions so
    // each child receives a fully-resolved task / system_prompt instead of
    // the raw `{{stream.objective}}` template. Only inline flow definitions
    // get substituted -- named flows are looked up at dispatch time and
    // their templates are resolved by the per-stage path. mode:inline
    // already does this via `substituteStageTemplates`; we mirror it here
    // for mode:spawn so the two modes have parity.
    const resolvedFlow =
      typeof spawnSpec.flow === "string"
        ? spawnSpec.flow
        : {
            ...spawnSpec.flow,
            stages: spawnSpec.flow.stages.map((s) => substituteStageTemplates(s, iterVars)),
          };

    // Spawn a child session for this iteration (string name or inline object)
    const spawnResult = await childSpawner.spawnChild(sessionId, forkGroup, resolvedFlow, resolvedInputs, i, {
      repo: resolvedRepo,
      branch: resolvedBranch,
      workdir: resolvedWorkdir,
      iterBudget,
    });
    if (!spawnResult.ok) {
      failedCount++;
      const msg = `for_each iteration ${i}: spawn failed: ${spawnResult.message}`;
      await deps.events.log(sessionId, "for_each_iteration_failed", {
        stage: (currentSession ?? session).stage,
        actor: "system",
        data: { index: i, item: JSON.stringify(item), reason: spawnResult.message },
      });
      if (onIterFailure === "stop") {
        await clearCheckpoint(deps.sessions, sessionId);
        return { ok: false, message: msg };
      }
      logWarn("session", msg, { sessionId, iteration: i });
      continue;
    }

    const childId = spawnResult.childId;
    spawnedChildIds.push(childId);

    // Record start time for per-iteration duration tracking.
    const spawnIterStartMs = Date.now();

    // Update in_flight with the child session id now that we have it.
    await writeCheckpoint(deps.sessions, sessionId, {
      stage_name: stageDef.name,
      total_items: items.length,
      items,
      next_index: i + 1,
      in_flight: {
        index: i,
        child_session_id: childId,
        started_at: new Date().toISOString(),
      },
    });

    await deps.events.log(sessionId, "for_each_iteration_start", {
      stage: (currentSession ?? session).stage,
      actor: "system",
      data: { index: i, childId, flow: flowLabel, inputs: resolvedInputs },
    });

    // Dispatch the child
    const dispatchResult = await deps.dispatchChild(childId);
    if (!dispatchResult.ok) {
      failedCount++;
      await deps.events.log(sessionId, "for_each_iteration_failed", {
        stage: (currentSession ?? session).stage,
        actor: "system",
        data: { index: i, childId, reason: `dispatch failed: ${dispatchResult.message}` },
      });
      if (onIterFailure === "stop") {
        await clearCheckpoint(deps.sessions, sessionId);
        return { ok: false, message: `for_each iteration ${i}: dispatch failed: ${dispatchResult.message}` };
      }
      logWarn("session", `for_each iteration ${i}: dispatch failed`, { sessionId, childId, iteration: i });
      continue;
    }

    // Wait for the child to reach a terminal state. Idle window resets on
    // each `updated_at` bump -- override default via stage YAML
    // `child_timeout_minutes:`.
    const idleMs =
      typeof stageDef.child_timeout_minutes === "number" && stageDef.child_timeout_minutes > 0
        ? stageDef.child_timeout_minutes * 60 * 1000
        : undefined;
    const terminalStatus = await childSpawner.waitForChild(childId, idleMs);
    const iterDurationMs = Date.now() - spawnIterStartMs;

    // Compute per-iteration cost from the child's hook_status events.
    const iterCostUsd = await sumPriorIterationCosts(deps.events, childId);

    // Fetch child session to get num_turns from result if available.
    const childSession = await deps.sessions.get(childId);
    const childTurns = (childSession?.config as Record<string, unknown> | null)?.num_turns as number | undefined;

    // Clear in_flight AFTER child reaches terminal (whether ok or not).
    await writeCheckpoint(deps.sessions, sessionId, {
      stage_name: stageDef.name,
      total_items: items.length,
      items,
      next_index: i + 1,
    });

    if (terminalStatus === "failed") {
      failedCount++;
      await deps.events.log(sessionId, "for_each_iteration_failed", {
        stage: (currentSession ?? session).stage,
        actor: "system",
        data: { index: i, childId, reason: "child session failed" },
      });
      if (onIterFailure === "stop") {
        await clearCheckpoint(deps.sessions, sessionId);
        return {
          ok: false,
          message: `for_each iteration ${i}: child session ${childId} failed`,
        };
      }
      logWarn("session", `for_each iteration ${i}: child failed, continuing`, { sessionId, childId, iteration: i });
      continue;
    }

    if (terminalStatus === "timeout") {
      failedCount++;
      await deps.events.log(sessionId, "for_each_iteration_failed", {
        stage: (currentSession ?? session).stage,
        actor: "system",
        data: { index: i, childId, reason: "child session timed out waiting for terminal state" },
      });
      if (onIterFailure === "stop") {
        await clearCheckpoint(deps.sessions, sessionId);
        return {
          ok: false,
          message: `for_each iteration ${i}: child session ${childId} timed out`,
        };
      }
      logWarn("session", `for_each iteration ${i}: child timed out, continuing`, {
        sessionId,
        childId,
        iteration: i,
      });
      continue;
    }

    succeeded++;
    await deps.events.log(sessionId, "for_each_iteration_complete", {
      stage: (currentSession ?? session).stage,
      actor: "system",
      data: {
        index: i,
        childId,
        exit_status: "completed",
        duration_ms: iterDurationMs,
        cost_usd: iterCostUsd,
        ...(childTurns !== undefined ? { turns: childTurns } : {}),
      },
    });
    logDebug("session", `for_each iteration ${i}: complete`, { sessionId, childId });
  }

  // All iterations done -- clear the checkpoint.
  await clearCheckpoint(deps.sessions, sessionId);

  await deps.events.log(sessionId, "for_each_complete", {
    stage: session.stage,
    actor: "system",
    data: { total: items.length, succeeded, failed: failedCount },
  });

  // Any iteration failure means the parent's stage outcome is a failure.
  // `on_iteration_failure: continue` only controls whether the LOOP keeps
  // dispatching on failure -- it doesn't make the eventual outcome succeed.
  // A partial success of a fan-out is still a failure at the parent level.
  if (failedCount > 0) {
    return {
      ok: false,
      message: `for_each: ${failedCount} of ${items.length} iterations failed (${succeeded} succeeded)`,
    };
  }
  return {
    ok: true,
    launched: false,
    reason: "for_each_spawn_complete",
    message: `for_each: ${items.length} iterations complete`,
  };
}
