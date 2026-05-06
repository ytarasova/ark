/**
 * Legacy provider-name -> (Compute, Isolation) pair mapping.
 *
 * Dispatch resolves a session through ComputeTarget keyed by the new two-axis
 * columns. Existing DB rows and CLI callers still use legacy provider names;
 * this mapping is the single authoritative place that turns a legacy name
 * into the new two-axis representation.
 *
 * Rules:
 *   - "local"              -> local + direct       (host running ark itself, worktree)
 *   - "docker"             -> local + docker       (arkd-sidecar container on localhost)
 *   - "devcontainer"       -> local + devcontainer (devcontainer.json on localhost)
 *   - "firecracker"        -> local + firecracker-in-container (local Firecracker microVM)
 *   - "ec2"                -> ec2 + direct         (remote worktree over arkd)
 *   - "ec2-docker"         -> ec2 + docker         (arkd-sidecar container on EC2)
 *   - "ec2-devcontainer"   -> ec2 + devcontainer   (devcontainer.json on EC2)
 *   - "ec2-firecracker"    -> ec2 + firecracker-in-container
 *   - "remote-arkd"        -> ec2 + direct         (legacy alias)
 *   - "remote-docker"      -> ec2 + docker
 *   - "remote-devcontainer"-> ec2 + devcontainer
 *   - "remote-firecracker" -> ec2 + firecracker-in-container
 *   - "k8s"                -> k8s + direct
 *   - "k8s-kata"           -> k8s-kata + direct
 *
 * Unknown names fall through to `local + direct` with a warning so callers
 * with bad data do not crash dispatch.
 */

import type { ComputeKind, IsolationKind } from "../types.js";

export interface ComputeIsolationPair {
  compute: ComputeKind;
  isolation: IsolationKind;
}

const PROVIDER_MAP: Record<string, ComputeIsolationPair> = {
  // Local host
  local: { compute: "local", isolation: "direct" },
  docker: { compute: "local", isolation: "docker" },
  devcontainer: { compute: "local", isolation: "devcontainer" },
  firecracker: { compute: "local", isolation: "firecracker-in-container" },

  // EC2 (remote) family
  ec2: { compute: "ec2", isolation: "direct" },
  "ec2-docker": { compute: "ec2", isolation: "docker" },
  "ec2-devcontainer": { compute: "ec2", isolation: "devcontainer" },
  "ec2-firecracker": { compute: "ec2", isolation: "firecracker-in-container" },

  // Legacy "remote-*" naming (pre-EC2 rename). Maps identically.
  "remote-arkd": { compute: "ec2", isolation: "direct" },
  "remote-worktree": { compute: "ec2", isolation: "direct" },
  "remote-docker": { compute: "ec2", isolation: "docker" },
  "remote-devcontainer": { compute: "ec2", isolation: "devcontainer" },
  "remote-firecracker": { compute: "ec2", isolation: "firecracker-in-container" },

  // Kubernetes
  k8s: { compute: "k8s", isolation: "direct" },
  "k8s-kata": { compute: "k8s-kata", isolation: "direct" },
};

/**
 * Map a legacy provider name to a {compute, isolation} pair.
 *
 * Returns a safe default (`local + direct`) for unknown names; callers that
 * care about unknown input should check `isKnownProvider()` first.
 */
export function providerToPair(name: string): ComputeIsolationPair {
  const hit = PROVIDER_MAP[name];
  if (hit) return hit;
  return { compute: "local", isolation: "direct" };
}

export function isKnownProvider(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDER_MAP, name);
}

/** Enumerate every known legacy provider name. Used by tests + UI. */
export function knownProviders(): string[] {
  return Object.keys(PROVIDER_MAP);
}

/** Reverse-map a pair back to a provider name (first match). Useful for UI. */
export function pairToProvider(pair: ComputeIsolationPair): string | null {
  for (const [name, entry] of Object.entries(PROVIDER_MAP)) {
    if (entry.compute === pair.compute && entry.isolation === pair.isolation) return name;
  }
  return null;
}

/**
 * Derive the legacy provider name from a compute object's two-axis kinds.
 *
 * Canonical accessor for call sites that need the legacy string (UI, log lines,
 * provider-registry lookups). Prefer this over reaching into a nonexistent
 * `.provider` field on `Compute`.
 */
export function providerOf(c: { compute_kind: ComputeKind; isolation_kind: IsolationKind }): string {
  return pairToProvider({ compute: c.compute_kind, isolation: c.isolation_kind }) ?? c.compute_kind;
}
