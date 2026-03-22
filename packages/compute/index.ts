/**
 * Compute layer — provider registry and public API.
 */

import type { ComputeProvider } from "./types.js";

// Re-export types
export type {
  ComputeProvider, ProvisionOpts, LaunchOpts, SyncOpts,
  HostSnapshot, HostMetrics, HostSession, HostProcess, DockerContainer,
  PortDecl, PortStatus, ArcJson,
} from "./types.js";

// ── Provider registry ───────────────────────────────────────────────────────

const providers = new Map<string, ComputeProvider>();

export function registerProvider(provider: ComputeProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): ComputeProvider | null {
  return providers.get(name) ?? null;
}

export function listProviders(): string[] {
  return [...providers.keys()];
}

export function clearProviders(): void {
  providers.clear();
}
