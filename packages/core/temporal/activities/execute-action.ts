import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("executeActionActivity: deps not injected");
  return _deps;
}

/**
 * Execute a non-agent action stage (create_pr, merge, close, ...).
 *
 * `executeAction` in services/actions/index.ts takes an AppContext reference.
 * In Phase 1, we surface the error as a dispatch_failed event rather than
 * crashing the workflow -- action stages will be fully wired in Phase 3 once
 * OrchestrationDeps carries a self-contained action executor.
 */
export async function executeActionActivity(input: {
  sessionId: string;
  stageIdx: number;
  action?: string;
}): Promise<void> {
  const d = deps();

  if (!input.action) {
    // No action specified -- nothing to execute.
    return;
  }

  // Phase 1 stub: emit an informational event rather than attempting to call
  // executeAction (which requires AppContext). Phase 3 will wire this through
  // a self-contained ActionDeps extracted from OrchestrationDeps.
  await d.events.log(input.sessionId, "action_skipped", {
    actor: "system",
    data: {
      action: input.action,
      reason: "executeActionActivity: Phase 1 stub -- action execution not yet wired via OrchestrationDeps",
      stageIdx: input.stageIdx,
    },
  });
}
