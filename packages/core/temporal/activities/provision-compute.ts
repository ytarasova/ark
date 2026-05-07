import { Context } from "@temporalio/activity";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("provisionComputeActivity: deps not injected");
  return _deps;
}

/**
 * Provision compute for a session stage.
 * For local+direct compute this is a no-op. k8s/EC2 provisioning is added in Phase 3
 * when per-stage compute targets ship.
 */
export async function provisionComputeActivity(input: { sessionId: string; computeName: string }): Promise<void> {
  const _d = deps();
  Context.current().heartbeat("provision-start");
  // Phase 1: local+direct compute needs no provisioning.
  // Phase 3 will dispatch to ComputeTarget.provision() based on computeName.
  void input;
}
