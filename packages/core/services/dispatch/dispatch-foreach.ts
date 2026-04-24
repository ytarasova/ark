/**
 * for_each dispatcher -- mode:spawn (P2.0a) and mode:inline (P2.5).
 *
 * mode:spawn -- Iterates a list resolved from session inputs/state and spawns
 * one child session per item sequentially. Each child is awaited before the
 * next one starts.
 *
 * mode:inline -- Iterates a list and runs a fixed list of sub-stages
 * sequentially IN THE PARENT SESSION per iteration. No child sessions, no
 * worktree clone. The parent's worktree is used for all sub-stages.
 *
 * Design constraints (both modes):
 *   - Sequential only (no parallel knob).
 *   - Iteration variable substitution via Nunjucks / substituteVars.
 *   - on_iteration_failure: stop (default) | continue.
 *
 * Durability (P3.2):
 *   Each loop writes a ForEachCheckpoint into session.config.for_each_checkpoint
 *   before dispatching iteration i. On daemon restart, boot reconciliation
 *   re-dispatches sessions with a checkpoint, and the dispatcher resumes from
 *   the checkpoint instead of starting fresh.
 *
 *   Resume approach for "already completed" detection: we scan child sessions
 *   with config.for_each_parent==parentId and build the completed set from
 *   their actual DB status rather than maintaining a completed[] array in the
 *   checkpoint. This is robust against the crash window between a child's
 *   SessionEnd hook and the parent's checkpoint update -- if the child row
 *   says "completed", the iteration is skipped regardless.
 *
 * Decomposition:
 *   This file holds the ForEachDispatcher class (a thin facade) plus the
 *   DispatchInlineSubStageCb surface-type re-export. All heavy lifting lives in
 *   sibling modules under ./foreach/:
 *     - budget.ts          cumulative-cost summation
 *     - checkpoint.ts      durable checkpoint read/write/clear
 *     - iteration-vars.ts  per-iteration var + template helpers
 *     - list-resolve.ts    resolving the iterable from session state
 *     - child-spawner.ts   child-session create + terminal wait
 *     - orchestration.ts   shared preamble/budget/empty-list helpers
 *     - spawn-loop.ts      mode:spawn orchestration body
 *     - inline-loop.ts     mode:inline orchestration body
 */

import type { DispatchDeps, DispatchResult } from "./types.js";
import type { StageDefinition } from "../../state/flow.js";

import { ForEachChildSpawner } from "./foreach/child-spawner.js";
import { dispatchForEachSpawn as runSpawnLoop } from "./foreach/spawn-loop.js";
import { dispatchForEachInline as runInlineLoop } from "./foreach/inline-loop.js";
import type { DispatchInlineSubStageCb as InlineSubStageCb } from "./foreach/inline-loop.js";

// Re-export helpers so tests + legacy call-sites can keep importing from the
// facade path `./dispatch-foreach.js` without knowing about the split.
export {
  buildIterationVars,
  flattenItem,
  substituteInputs,
  substituteStageTemplates,
} from "./foreach/iteration-vars.js";
export { resolveForEachList, coerceToArray, resolveDotted } from "./foreach/list-resolve.js";

/**
 * Callback for dispatching a single inline sub-stage against the parent
 * session's worktree. Implemented by CoreDispatcher and injected here so
 * ForEachDispatcher doesn't need to import the full agent-dispatch pipeline.
 *
 * The callback receives the parent sessionId, the resolved sub-stage definition
 * (already template-substituted), and the iteration vars used for the sub-stage.
 * It should launch the agent, wait for terminal, and return ok/failed.
 *
 * Re-exported here so existing consumers (tests, dispatch-core) keep importing
 * it from "./dispatch-foreach.js".
 */
export type DispatchInlineSubStageCb = InlineSubStageCb;

/**
 * Thin orchestrator that wires the per-iteration helpers together and routes
 * to the spawn or inline loop based on `stageDef.mode`.
 *
 * All behavioural logic lives in the ./foreach/*.ts modules. This class only
 * holds the constructor-injected deps, owns a ForEachChildSpawner, and
 * delegates dispatchForEach{Spawn,Inline} to the respective modules.
 */
export class ForEachDispatcher {
  private readonly childSpawner: ForEachChildSpawner;

  constructor(
    private readonly deps: Pick<DispatchDeps, "sessions" | "events" | "flows" | "dispatchChild"> & {
      /** Required only for mode:inline sub-stage dispatch. */
      dispatchInlineSubStage?: DispatchInlineSubStageCb;
    },
  ) {
    this.childSpawner = new ForEachChildSpawner({ sessions: deps.sessions, flows: deps.flows });
  }

  /**
   * Dispatcher switch: routes to spawn or inline based on stageDef.mode.
   * Default (omitted) is spawn for backward compat with P2.0a.
   */
  async dispatchForEach(
    sessionId: string,
    stageDef: StageDefinition,
    /** Pre-built flat session var map (ticket, summary, inputs.*, etc.) */
    sessionVars: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const mode = stageDef.mode ?? "spawn";
    if (mode === "inline") {
      return this.dispatchForEachInline(sessionId, stageDef, sessionVars);
    }
    return this.dispatchForEachSpawn(sessionId, stageDef, sessionVars);
  }

  /** See ./foreach/spawn-loop.ts for the full implementation. */
  async dispatchForEachSpawn(
    sessionId: string,
    stageDef: StageDefinition,
    sessionVars: Record<string, unknown>,
  ): Promise<DispatchResult> {
    return runSpawnLoop(this.deps, this.childSpawner, sessionId, stageDef, sessionVars);
  }

  /** See ./foreach/inline-loop.ts for the full implementation. */
  async dispatchForEachInline(
    sessionId: string,
    stageDef: StageDefinition,
    sessionVars: Record<string, unknown>,
  ): Promise<DispatchResult> {
    return runInlineLoop(this.deps, this.deps.dispatchInlineSubStage, sessionId, stageDef, sessionVars);
  }
}
