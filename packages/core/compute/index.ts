/**
 * Compute layer - public API.
 *
 * The provider registry lives on AppContext. The `app()`-bound delegates
 * below are kept thin so call sites that haven't been migrated to direct
 * AppContext access still resolve. Task 5 deletes these proxies along
 * with the legacy `ComputeProvider` interface entirely.
 */

import type { ComputeProvider } from "./legacy-provider.js";
import type { AppContext } from "../app.js";

// Legacy provider interface -- on its way out (Task 5).
export type {
  ComputeProvider,
  IsolationMode,
  ProvisionOpts as LegacyProvisionOpts,
  LaunchOpts as LegacyLaunchOpts,
  SyncOpts,
} from "./legacy-provider.js";

export function getIsolationModes(providerName: string): { value: string; label: string }[] {
  const provider = getProvider(providerName);
  return provider?.isolationModes ?? [];
}

// ── Provider registry (delegates to AppContext) ─────────────────────────────

let _app: AppContext | null = null;

/** Set the AppContext used by the compute registry. Called from AppContext.boot(). */
export function setComputeApp(app: AppContext): void {
  _app = app;
}

function app(): AppContext {
  if (!_app) throw new Error("Compute registry not initialized -- call setComputeApp() first");
  return _app;
}

export function registerProvider(provider: ComputeProvider): void {
  app().registerProvider(provider);
}

export function getProvider(name: string): ComputeProvider | null {
  return app().getProvider(name);
}

export function listProviders(): string[] {
  return app().listProviders();
}

export function clearProviders(): void {
  // noop -- AppContext owns the registry
}

// ── Compute + Isolation split ──────────────────────────────────────────────
//
// Primary abstractions. See `docs/architecture.md`.

export type {
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  Isolation,
  IsolationKind,
  AgentHandle,
  ProvisionLatency,
  PrepareCtx,
  ProvisionOpts,
  LaunchOpts,
  Snapshot,
  ComputeSnapshot,
  AttachExistingComputeRow,
  EnsureReachableOpts,
  PrepareWorkspaceOpts,
  FlushPlacementOpts,
} from "./types.js";
export { NotSupportedError } from "./types.js";

export { LocalCompute } from "./local.js";
export { EC2Compute } from "./ec2/compute.js";
export type { EC2HandleMeta, EC2ProvisionConfig, EC2ComputeHelpers } from "./ec2/compute.js";
export { K8sCompute } from "./k8s.js";
export type { K8sComputeConfig, K8sHandleMeta, K8sComputeDeps } from "./k8s.js";
export { KataCompute, DEFAULT_KATA_RUNTIME_CLASS } from "./k8s-kata.js";
export { DirectIsolation } from "./isolation/direct.js";
export { DockerIsolation } from "./isolation/docker.js";
export { DevcontainerIsolation } from "./isolation/devcontainer.js";
export { DockerComposeIsolation } from "./isolation/docker-compose.js";
export { ComputeTarget } from "./compute-target.js";

// FirecrackerCompute. Re-export from the firecracker barrel so consumers
// don't have to reach into the subtree. The sibling barrel
// (`./firecracker/index.ts`) also exports the low-level `createVm` and
// network helpers for the pool layer.
export { FirecrackerCompute, registerFirecrackerIfAvailable } from "./firecracker/compute.js";
export type { FirecrackerComputeDeps, FirecrackerMeta } from "./firecracker/compute.js";

export { providerToPair, pairToProvider, isKnownProvider, knownProviders } from "./adapters/provider-map.js";
export type { ComputeIsolationPair } from "./adapters/provider-map.js";

// ── Snapshot persistence ───────────────────────────────────────────────────

export type { SnapshotStore, SnapshotRef, SnapshotBlob, SnapshotListFilter } from "./snapshot-store.js";
export { SnapshotNotFoundError } from "./snapshot-store.js";
export { FsSnapshotStore } from "./snapshot-store-fs.js";

// ── Compute pool ───────────────────────────────────────────────────────────

export type { ComputePool, PoolConfig, PoolStats } from "./warm-pool/types.js";
export { defaultPoolConfig } from "./warm-pool/types.js";
export { LocalFirecrackerPool } from "./warm-pool/local-firecracker-pool.js";

// ── Flag specs (CLI-layer adapter) ─────────────────────────────────────────

export type { ProviderFlagSpec, ProviderFlagOption } from "./flag-spec.js";
export { allFlagSpecs, getFlagSpec, flagSpecRegistry } from "./flag-specs/index.js";
