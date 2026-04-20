/**
 * Stage orchestration barrel -- re-exports from focused modules.
 *
 * The 1200+ line implementation was decomposed into:
 *   - dispatch.ts       -- dispatch, resume, resolveComputeForStage, fork/fan-out dispatchers
 *   - stage-advance.ts  -- advance, complete, handoff, non-Claude transcript parsing
 *   - actions/index.ts  -- executeAction (create_pr, merge, auto_merge, close) via handler registry
 *   - fork-join.ts      -- fork, joinFork, checkAutoJoin, fanOut
 *   - subagents.ts      -- spawnSubagent, spawnParallelSubagents
 *
 * All existing imports from "./stage-orchestrator.js" continue to work.
 */

export { dispatch, resume, resolveComputeForStage } from "./dispatch.js";
export { advance, complete, handoff } from "./stage-advance.js";
export { executeAction } from "./actions/index.js";
export { fork, joinFork, checkAutoJoin, fanOut } from "./fork-join.js";
export { spawnSubagent, spawnParallelSubagents } from "./subagents.js";
