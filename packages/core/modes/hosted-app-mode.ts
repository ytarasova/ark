/**
 * Hosted AppMode -- every filesystem / single-user capability is `null`.
 *
 * In hosted multi-tenant mode the server has no per-tenant filesystem view,
 * so every capability whose implementation would touch a local path or a
 * tenant-shared SQLite cache is explicitly absent. Handlers that depend on
 * these capabilities aren't registered at all (preferred) or refuse the call
 * with a consistent `RpcError` via the shared wrapper.
 */

import type { AppMode, ComputeBootstrapCapability } from "./app-mode.js";

/**
 * Hosted compute bootstrap is intentionally a no-op. The operator
 * registers real compute targets (k8s / docker / ec2 / firecracker) post-
 * onboarding via `ark compute add`. We never silently seed a `local` row
 * because "local" inside a control-plane pod means agents would spawn in
 * the control-plane container itself -- no isolation, competes with the
 * control plane for resources.
 */
function makeNoopComputeBootstrap(): ComputeBootstrapCapability {
  return { seed: () => undefined };
}

export function buildHostedAppMode(): AppMode {
  return {
    kind: "hosted",
    fsCapability: null,
    knowledgeCapability: null,
    mcpDirCapability: null,
    repoMapCapability: null,
    ftsRebuildCapability: null,
    hostCommandCapability: null,
    computeBootstrap: makeNoopComputeBootstrap(),
  };
}
