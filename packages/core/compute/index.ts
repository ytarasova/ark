/**
 * Compute layer -- public API.
 *
 * The new-world surface: the `Compute` + `Isolation` two-axis abstraction
 * (composed via `ComputeTarget`), the concrete impls (Local / EC2 / K8s /
 * Kata / Firecracker x Direct / Docker / Devcontainer / DockerCompose),
 * snapshot persistence, the warm pool, port discovery, and a couple of
 * shared helpers. See `docs/architecture.md`.
 *
 * The legacy `ComputeProvider` interface is intentionally NOT re-exported
 * from here -- the two executors (`claude-agent.ts`, `claude-code.ts`)
 * and the server handlers that still consult `app.getProvider(name)`
 * import it directly from `./legacy-provider.js` (deferred sweeps
 * tracked in #527, #528).
 */

// ── Compute + Isolation split ──────────────────────────────────────────────

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

// ── Computes ───────────────────────────────────────────────────────────────

export { LocalCompute } from "./local.js";
export { EC2Compute } from "./ec2/compute.js";
export type { EC2HandleMeta, EC2ProvisionConfig, EC2ComputeHelpers } from "./ec2/compute.js";
export { K8sCompute } from "./k8s.js";
export type { K8sComputeConfig, K8sHandleMeta, K8sComputeDeps } from "./k8s.js";
export { KataCompute, DEFAULT_KATA_RUNTIME_CLASS } from "./k8s-kata.js";

// FirecrackerCompute. Re-export from the firecracker barrel so consumers
// don't have to reach into the subtree. The sibling barrel
// (`./firecracker/index.ts`) also exports the low-level `createVm` and
// network helpers for the pool layer.
export { FirecrackerCompute, registerFirecrackerIfAvailable } from "./firecracker/compute.js";
export type { FirecrackerComputeDeps, FirecrackerMeta } from "./firecracker/compute.js";

// ── Isolations ─────────────────────────────────────────────────────────────

export { DirectIsolation } from "./isolation/direct.js";
export { DockerIsolation } from "./isolation/docker.js";
export { DevcontainerIsolation } from "./isolation/devcontainer.js";
export { DockerComposeIsolation } from "./isolation/docker-compose.js";
export type { DockerIsolationConfig } from "./isolation/docker-config.js";

// ── Composer ───────────────────────────────────────────────────────────────

export { ComputeTarget } from "./compute-target.js";

// ── Snapshot persistence ───────────────────────────────────────────────────

export type { SnapshotStore, SnapshotRef, SnapshotBlob, SnapshotListFilter } from "./snapshot-store.js";
export { SnapshotNotFoundError } from "./snapshot-store.js";
export { FsSnapshotStore } from "./snapshot-store-fs.js";

// ── Compute pool ───────────────────────────────────────────────────────────

export type { ComputePool, PoolConfig, PoolStats } from "./warm-pool/types.js";
export { defaultPoolConfig } from "./warm-pool/types.js";
export { LocalFirecrackerPool } from "./warm-pool/local-firecracker-pool.js";

// ── Port discovery ─────────────────────────────────────────────────────────

export { discoverWorkspacePorts, type PortDecl } from "./isolation/ports.js";
export { discoverDevcontainerPorts } from "./isolation/devcontainer.js";
export { discoverComposePorts, findComposeFile } from "./isolation/docker-compose.js";

// ── Shared helpers ─────────────────────────────────────────────────────────

export { cloneWorkspaceViaArkd } from "./workspace-clone.js";
export { attachComputeMethods, buildAgentHandle } from "./handle-helpers.js";
