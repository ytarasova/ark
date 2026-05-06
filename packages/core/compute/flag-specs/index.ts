/**
 * Provider flag-spec registry.
 *
 * Maps provider keys (the legacy `--provider` value + any aliases we still
 * accept, eg `k8s-kata`) to a `ProviderFlagSpec`. The CLI uses
 * `allFlagSpecs()` to register Commander options and `getFlagSpec(name)` to
 * resolve the spec once the user's provider is known.
 */

import type { ProviderFlagSpec } from "../flag-spec.js";
import { dockerFlagSpec } from "./docker.js";
import { ec2FlagSpec } from "./ec2.js";
import { firecrackerFlagSpec } from "./firecracker.js";
import { k8sFlagSpec } from "./k8s.js";
import { localFlagSpec } from "./local.js";

/**
 * Registry entries. Order matters only for `allFlagSpecs()` iteration, which
 * in turn drives Commander option registration order in the CLI.
 *
 * Aliases (same spec under a different provider key):
 *   - `k8s-kata` -> k8s spec (both set the same config keys)
 */
export const flagSpecRegistry: Map<string, ProviderFlagSpec> = new Map([
  ["local", localFlagSpec],
  ["docker", dockerFlagSpec],
  ["ec2", ec2FlagSpec],
  ["k8s", k8sFlagSpec],
  ["k8s-kata", k8sFlagSpec],
  ["firecracker", firecrackerFlagSpec],
]);

/**
 * Return every registered spec, de-duplicated by identity (so aliases like
 * `k8s-kata` -> `k8s` don't double-register). Order matches insertion order.
 */
export function allFlagSpecs(): ProviderFlagSpec[] {
  const seen = new Set<ProviderFlagSpec>();
  const out: ProviderFlagSpec[] = [];
  for (const spec of flagSpecRegistry.values()) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    out.push(spec);
  }
  return out;
}

/** Resolve a spec by provider key (including aliases). `null` if unknown. */
export function getFlagSpec(name: string): ProviderFlagSpec | null {
  return flagSpecRegistry.get(name) ?? null;
}

export type { ProviderFlagSpec, ProviderFlagOption } from "../flag-spec.js";
