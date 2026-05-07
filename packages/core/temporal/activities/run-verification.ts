import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("runVerificationActivity: deps not injected");
  return _deps;
}

/**
 * Run post-stage verification checks.
 *
 * Phase 1 stub: no verification logic exists in the bespoke engine yet.
 * Returns passed: true unconditionally. Phase 3 will wire this to the review-gate
 * and plan-artifact checkers that will be extracted into OrchestrationDeps.
 */
export async function runVerificationActivity(input: { sessionId: string }): Promise<{ passed: boolean }> {
  const _d = deps();
  void input;
  return { passed: true };
}
