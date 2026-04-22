/**
 * Worktree services barrel.
 *
 * Re-exports the public surface of the split workspace-service so existing
 * importers have a single path to reach for worktree operations. Split by
 * concern:
 *
 *   - setup.ts   -> create/copy/cleanup worktrees + attachment materialization
 *   - git-ops.ts -> diff/rebase/finish on existing worktrees
 *   - pr.ts      -> GitHub PR create/merge via gh CLI
 */

export {
  safeAttachmentName,
  setupSessionWorktree,
  materializeAttachments,
  copyWorktreeFiles,
  runWorktreeSetup,
  removeSessionWorktree,
  findOrphanedWorktrees,
  cleanupWorktrees,
} from "./setup.js";

export { worktreeDiff, rebaseOntoBase, finishWorktree, injectWorktreeDeps } from "./git-ops.js";

export { createWorktreePR, mergeWorktreePR } from "./pr.js";
