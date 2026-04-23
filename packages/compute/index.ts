/**
 * Compute layer - provider registry and public API.
 *
 * The provider registry lives on AppContext. These functions are thin
 * delegates that require AppContext to be booted. No fallback map,
 * no auto-registration -- all lifecycle goes through AppContext.boot().
 */

import type { ComputeProvider } from "./types.js";
import type { AppContext } from "../core/app.js";

// Re-export types
export type {
  ComputeProvider,
  IsolationMode,
  ProvisionOpts,
  LaunchOpts,
  SyncOpts,
  ComputeSnapshot,
  ComputeMetrics,
  ComputeSession,
  ComputeProcess,
  DockerContainer,
  PortDecl,
  PortStatus,
  ArcJson,
  ArcComposeConfig,
  ArcDevcontainerConfig,
} from "./types.js";

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

// ArkD-backed providers (new universal architecture)
import {
  LocalWorktreeProvider,
  LocalDockerProvider,
  LocalDevcontainerProvider,
  LocalFirecrackerProvider,
} from "./providers/local-arkd.js";
export { LocalWorktreeProvider, LocalDockerProvider, LocalDevcontainerProvider, LocalFirecrackerProvider };

import {
  RemoteWorktreeProvider,
  RemoteDockerProvider,
  RemoteDevcontainerProvider,
  RemoteFirecrackerProvider,
} from "./providers/remote-arkd.js";
export { RemoteWorktreeProvider, RemoteDockerProvider, RemoteDevcontainerProvider, RemoteFirecrackerProvider };

// Kubernetes providers (vanilla + Kata/Firecracker)
import { K8sProvider, KataProvider } from "./providers/k8s.js";
export { K8sProvider, KataProvider };

// arc.json
export { parseArcJson, resolvePortDecls, hasDevcontainer, hasComposeFile } from "./arc-json.js";

// ── Compute + Runtime split ────────────────────────────────────────────────
//
// New primary abstractions. Live alongside ComputeProvider; the old interface
// retires once every dispatch path reads from these. See
// `.workflow/plan/compute-runtime-vision.md`.

export type {
  Compute as NewCompute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  Runtime,
  RuntimeKind,
  AgentHandle,
  ProvisionLatency,
  PrepareCtx,
  ProvisionOpts as NewProvisionOpts,
  LaunchOpts as NewLaunchOpts,
  Snapshot,
} from "./core/types.js";
export { NotSupportedError } from "./core/types.js";

export { LocalCompute } from "./core/local.js";
export { EC2Compute } from "./core/ec2.js";
export type { EC2HandleMeta, EC2ProvisionConfig, EC2ComputeHelpers } from "./core/ec2.js";
export { K8sCompute } from "./core/k8s.js";
export type { K8sComputeConfig, K8sHandleMeta, K8sComputeDeps } from "./core/k8s.js";
export { KataCompute, DEFAULT_KATA_RUNTIME_CLASS } from "./core/k8s-kata.js";
export { DirectRuntime } from "./runtimes/direct.js";
export { DockerComposeRuntime } from "./runtimes/docker-compose.js";
export { ComputeTarget } from "./core/compute-target.js";
export { computeProviderToTarget } from "./adapters/legacy.js";

// FirecrackerCompute. Re-export from the firecracker barrel so consumers
// don't have to reach into the core subtree. The sibling barrel
// (`./core/firecracker/index.ts`) also exports the low-level `createVm` and
// network helpers for the pool layer.
export { FirecrackerCompute, registerFirecrackerIfAvailable } from "./core/firecracker/compute.js";
export type { FirecrackerComputeDeps, FirecrackerMeta } from "./core/firecracker/compute.js";

export { providerToPair, pairToProvider, isKnownProvider, knownProviders } from "./adapters/provider-map.js";
export type { ComputeRuntimePair } from "./adapters/provider-map.js";

// ── Snapshot persistence ───────────────────────────────────────────────────

export type { SnapshotStore, SnapshotRef, SnapshotBlob, SnapshotListFilter } from "./core/snapshot-store.js";
export { SnapshotNotFoundError } from "./core/snapshot-store.js";
export { FsSnapshotStore } from "./core/snapshot-store-fs.js";

// ── Compute pool ───────────────────────────────────────────────────────────

export type { ComputePool, PoolConfig, PoolStats } from "./core/pool/types.js";
export { defaultPoolConfig } from "./core/pool/types.js";
export { LocalFirecrackerPool } from "./core/pool/local-firecracker-pool.js";

// ── Flag specs (CLI-layer adapter) ─────────────────────────────────────────

export type { ProviderFlagSpec, ProviderFlagOption } from "./flag-spec.js";
export { allFlagSpecs, getFlagSpec, flagSpecRegistry } from "./flag-specs/index.js";
