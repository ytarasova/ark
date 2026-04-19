/**
 * Compute layer - provider registry and public API.
 *
 * The provider registry lives on AppContext. These functions are thin
 * delegates that require AppContext to be booted. No fallback map,
 * no auto-registration — all lifecycle goes through AppContext.boot().
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
  // noop — AppContext owns the registry
}

// Legacy provider classes (kept for backward compatibility during migration)
import { LocalProvider } from "./providers/local/index.js";
export { LocalProvider };

import { DockerProvider } from "./providers/docker/index.js";
export { DockerProvider };

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

// E2B managed sandbox provider
import { E2BProvider } from "./providers/e2b.js";
export { E2BProvider };

// Kubernetes providers (vanilla + Kata/Firecracker)
import { K8sProvider, KataProvider } from "./providers/k8s.js";
export { K8sProvider, KataProvider };

// arc.json
export { parseArcJson, resolvePortDecls, hasDevcontainer, hasComposeFile } from "./arc-json.js";

// ── Wave 1: Compute + Runtime split ────────────────────────────────────────
//
// New primary abstractions. Live alongside ComputeProvider; Wave 3 retires
// the old interface. See `.workflow/plan/compute-runtime-vision.md`.

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
export { DirectRuntime } from "./runtimes/direct.js";
export { DockerComposeRuntime } from "./runtimes/docker-compose.js";
export { ComputeTarget } from "./core/compute-target.js";
export { computeProviderToTarget } from "./adapters/legacy.js";
