/**
 * Compute layer - provider registry and public API.
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

// Providers
import { LocalProvider } from "./providers/local/index.js";
export { LocalProvider };

// Auto-register local provider
registerProvider(new LocalProvider());

import { EC2Provider } from "./providers/ec2/index.js";
export { EC2Provider };

// Auto-register EC2 provider
registerProvider(new EC2Provider());

import { DockerProvider } from "./providers/docker/index.js";
export { DockerProvider };

// Auto-register Docker provider
registerProvider(new DockerProvider());

// arc.json
export { parseArcJson, resolvePortDecls, hasDevcontainer, hasComposeFile } from "./arc-json.js";
