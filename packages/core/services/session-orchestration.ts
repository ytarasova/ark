/**
 * Session orchestration barrel -- re-exports from focused service modules.
 *
 * This file was decomposed from a 3100+ line god file into:
 *   - session-lifecycle.ts -- Session CRUD, stop/resume/pause/archive, delete, verification
 *   - stage-orchestrator.ts -- dispatch, advance, fork/join, fan-out, subagents, actions
 *   - task-builder.ts -- Prompt construction, subtask extraction
 *   - worktree-service.ts -- Git worktree create/remove, file copy, diff, PR, cleanup
 *   - agent-launcher.ts -- Agent process launching, remote environment prep
 *   - session-output.ts -- Output capture, message sending
 *
 * All existing imports from "./session-orchestration.js" continue to work.
 */

// ── Session lifecycle ────────────────────────────────────────────────────────
export {
  startSession,
  recordSessionUsage,
  stop,
  runVerification,
  pause,
  archive,
  restore,
  interrupt,
  forkSession,
  cloneSession,
  deleteSessionAsync,
  undeleteSessionAsync,
  cleanupOnTerminal,
  waitForCompletion,
} from "./session-lifecycle.js";
export type { SessionOpResult } from "./session-lifecycle.js";

// ── Stage orchestration ──────────────────────────────────────────────────────
export {
  dispatch,
  advance,
  resume,
  resolveComputeForStage,
  executeAction,
  complete,
  handoff,
  fork,
  joinFork,
  checkAutoJoin,
  fanOut,
  spawnSubagent,
  spawnParallelSubagents,
} from "./stage-orchestrator.js";

// ── Task building ────────────────────────────────────────────────────────────
export { formatTaskHeader, buildTaskWithHandoff, extractSubtasks } from "./task-builder.js";

// ── Worktree management ──────────────────────────────────────────────────────
export {
  setupSessionWorktree,
  copyWorktreeFiles,
  runWorktreeSetup,
  worktreeDiff,
  rebaseOntoBase,
  createWorktreePR,
  mergeWorktreePR,
  finishWorktree,
  removeSessionWorktree,
  findOrphanedWorktrees,
  cleanupWorktrees,
} from "./worktree-service.js";

// ── Agent launching ──────────────────────────────────────────────────────────
export { prepareRemoteEnvironment } from "./agent-launcher.js";

// ── Output & messaging ──────────────────────────────────────────────────────
export { getOutput, send } from "./session-output.js";

// ── Review gate (wraps advance from stage-orchestrator) ─────────────────────
import { advance as _advance } from "./stage-orchestrator.js";
import { approveReviewGate as _approveReviewGate } from "./session-lifecycle.js";

export async function approveReviewGate(
  app: import("../app.js").AppContext,
  sessionId: string,
): Promise<{ ok: boolean; message: string }> {
  return _approveReviewGate(app, sessionId, _advance);
}

// ── Re-exports from session-hooks.ts (hook status, reports, stage handoff) ──
export {
  applyHookStatus,
  applyReport,
  mediateStageHandoff,
  parseOnFailure,
  retryWithContext,
  detectStatus,
} from "./session-hooks.js";
export type { HookStatusResult, ReportResult, StageHandoffResult } from "./session-hooks.js";

// ── Inject cross-module dependencies to break circular imports ──────────────
import { injectWorktreeDeps } from "./worktree-service.js";
import { deleteSessionAsync, stop, runVerification } from "./session-lifecycle.js";

injectWorktreeDeps({ deleteSessionAsync, stop, runVerification });
