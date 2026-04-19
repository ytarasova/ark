/**
 * KataCompute -- k8s pod runtime with Kata Containers (microVM isolation).
 *
 * Inherits the full K8sCompute lifecycle but flips two things:
 *   1. Capabilities -- `snapshot: true` and `networkIsolation: true`
 *      (Kata gives us a microVM per pod; Firecracker-class snapshotting
 *      is achievable, but the wiring itself lands in Phase 3).
 *   2. Pod spec -- every pod is annotated with `runtimeClassName: kata`
 *      (or the override from `ProvisionOpts.config.runtimeClassName`).
 *
 * `snapshot` and `restore` still throw `NotSupportedError`; Phase 3's PR
 * replaces them with real impls. Gating the capability flag already lets
 * the registry treat Kata as a snapshot-capable backend without forcing
 * callers to special-case the in-progress state.
 */

import type { ComputeCapabilities, ComputeHandle, ComputeKind, Snapshot } from "./types.js";
import { NotSupportedError } from "./types.js";
import { K8sCompute, type K8sComputeConfig, type K8sHandleMeta } from "./k8s.js";

/** Default Kata runtime class. Overridable via `ProvisionOpts.config.runtimeClassName`. */
export const DEFAULT_KATA_RUNTIME_CLASS = "kata";

export class KataCompute extends K8sCompute {
  readonly kind: ComputeKind = "k8s-kata";
  readonly capabilities: ComputeCapabilities = {
    snapshot: true,
    pool: true,
    networkIsolation: true,
    provisionLatency: "seconds",
  };

  protected augmentPodSpec(spec: Record<string, unknown>, cfg: K8sComputeConfig): Record<string, unknown> {
    const runtimeClassName = cfg.runtimeClassName ?? DEFAULT_KATA_RUNTIME_CLASS;
    return { ...spec, runtimeClassName };
  }

  protected buildHandleMeta(base: K8sHandleMeta, cfg: K8sComputeConfig): K8sHandleMeta {
    return { ...base, runtimeClassName: cfg.runtimeClassName ?? DEFAULT_KATA_RUNTIME_CLASS };
  }

  // Phase 3 replaces these with real snapshot/restore against the Kata
  // runtime. Capability flag is `true` so the registry routes through us,
  // but we fail loudly until that work lands.

  async snapshot(_h: ComputeHandle): Promise<Snapshot> {
    throw new NotSupportedError(this.kind, "snapshot");
  }

  async restore(_s: Snapshot): Promise<ComputeHandle> {
    throw new NotSupportedError(this.kind, "restore");
  }
}
