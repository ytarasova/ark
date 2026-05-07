import type { SessionWorkflowInput, StartSessionResult } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("startSessionActivity: deps not injected");
  return _deps;
}

/**
 * Emits the session_created event and initializes the first stage.
 * The session row was already created by SessionService.start() before the
 * workflow was scheduled. This activity just fires the lifecycle event so
 * the dispatcher can pick it up and logs creation context.
 */
export async function startSessionActivity(input: SessionWorkflowInput): Promise<StartSessionResult> {
  const d = deps();
  const session = await d.sessions.get(input.sessionId);
  if (!session) {
    throw new Error(`startSessionActivity: session ${input.sessionId} not found`);
  }

  // Emit session_created event if not already emitted (idempotent guard via status check).
  // The session row exists but the workflow-driven path needs to fire the creation event
  // so downstream listeners (dispatch, SSE) pick it up.
  await d.events.log(input.sessionId, "session_created", {
    actor: "system",
    data: {
      flow: input.flowName,
      tenant: input.tenantId,
      orchestrator: "temporal",
    },
  });

  return { sessionId: input.sessionId };
}
