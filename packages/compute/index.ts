/**
 * Compute layer - provider registry and public API.
 *
 * The provider registry lives on AppContext. These functions are thin
 * delegates that require AppContext to be booted. No fallback map,
 * no auto-registration — all lifecycle goes through AppContext.boot().
 */

import type { ComputeProvider } from "./types.js";

// Re-export types
export type {
  ComputeProvider, IsolationMode, ProvisionOpts, LaunchOpts, SyncOpts,
  ComputeSnapshot, ComputeMetrics, ComputeSession, ComputeProcess, DockerContainer,
  PortDecl, PortStatus, ArcJson,
} from "./types.js";

export function getIsolationModes(providerName: string): { value: string; label: string }[] {
  const provider = getProvider(providerName);
  return provider?.isolationModes ?? [];
}

// ── Provider registry (delegates to AppContext) ─────────────────────────────

function app() {
  const { getApp } = require("../core/app.js");
  return getApp();
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

import { EC2Provider } from "./providers/ec2/index.js";
export { EC2Provider };

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

// arc.json
export { parseArcJson, resolvePortDecls, hasDevcontainer, hasComposeFile } from "./arc-json.js";
