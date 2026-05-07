import type { DispatchStageResult } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("dispatchStageActivity: deps not injected");
  return _deps;
}

/**
 * Dispatch the current stage of a session: resolve agent, build task, launch executor.
 *
 * Delegates to the bespoke DispatchService via the optional `dispatch` callback
 * wired at worker bootstrap time through depsFromApp. Phase 3 will replace this
 * with a self-contained activity that constructs its own DispatchDeps from
 * OrchestrationDeps so no AppContext back-reference is needed.
 */
export async function dispatchStageActivity(input: {
  sessionId: string;
  stageIdx: number;
}): Promise<DispatchStageResult> {
  const d = deps();

  if (!d.dispatch) {
    // Emit dispatch_failed so the session surfaces the issue rather than hanging.
    await d.events.log(input.sessionId, "dispatch_failed", {
      actor: "system",
      data: {
        reason: "dispatchStageActivity: dispatch callback not wired on OrchestrationDeps",
        stageIdx: input.stageIdx,
      },
    });
    return {};
  }

  const result = await d.dispatch(input.sessionId);
  return {
    launchPid: (result as any)?.pid ?? undefined,
    launchId: (result as any)?.handle ?? undefined,
  };
}
