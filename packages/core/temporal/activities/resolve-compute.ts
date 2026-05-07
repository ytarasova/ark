import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("resolveComputeForStageActivity: deps not injected");
  return _deps;
}

/**
 * Resolve the compute name for the given stage.
 * Falls back to "local" if no compute_name is set on the session row.
 * Phase 3 will wire per-stage compute template resolution through DispatchService.
 */
export async function resolveComputeForStageActivity(input: {
  sessionId: string;
  stageIdx: number;
}): Promise<{ computeName: string }> {
  const d = deps();
  const session = await d.sessions.get(input.sessionId);
  return { computeName: (session as any)?.compute_name ?? "local" };
}
