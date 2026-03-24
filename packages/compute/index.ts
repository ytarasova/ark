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
  ComputeProvider, ProvisionOpts, LaunchOpts, SyncOpts,
  ComputeSnapshot, ComputeMetrics, ComputeSession, ComputeProcess, DockerContainer,
  PortDecl, PortStatus, ArcJson,
} from "./types.js";

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

// Provider classes (exported for AppContext to instantiate during boot)
import { LocalProvider } from "./providers/local/index.js";
export { LocalProvider };

import { EC2Provider } from "./providers/ec2/index.js";
export { EC2Provider };

import { DockerProvider } from "./providers/docker/index.js";
export { DockerProvider };

// arc.json
export { parseArcJson, resolvePortDecls, hasDevcontainer, hasComposeFile } from "./arc-json.js";
