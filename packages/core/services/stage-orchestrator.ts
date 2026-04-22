/**
 * Stage orchestration barrel -- re-exports from focused modules.
 *
 * The 1200+ line implementation was decomposed into:
 *   - dispatch/           -- DispatchService (see app.dispatchService)
 *   - stage-advance/      -- StageAdvanceService (advance/complete/handoff/executeAction)
 *   - actions/index.ts    -- executeAction (create_pr, merge, auto_merge, close) via handler registry
 *   - fork-join.ts        -- fork, joinFork, checkAutoJoin, fanOut
 *   - subagents.ts        -- spawnSubagent, spawnParallelSubagents
 *
 * `advance`/`complete`/`handoff`/`dispatch`/`resume` are no longer free
 * functions -- use `app.stageAdvance.X` / `app.dispatchService.X`.
 */

export { executeAction } from "./actions/index.js";
export { fork, joinFork, checkAutoJoin, fanOut } from "./fork-join.js";
export { spawnSubagent, spawnParallelSubagents } from "./subagents.js";
