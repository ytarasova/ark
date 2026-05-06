export type ComputeStatus = "stopped" | "running" | "provisioning" | "destroyed" | "failed";
export type ComputeProviderName = "local" | "docker" | "ec2" | "remote-arkd";

/**
 * Where the compute lives. Mirrors `ComputeKind` in packages/compute/core/types.ts
 * (duplicated here as a string union to avoid a cross-package import cycle).
 */
export type ComputeKindName = "local" | "firecracker" | "ec2" | "k8s" | "k8s-kata";

/**
 * How the agent process is sandboxed inside the compute. Mirrors `IsolationKind`.
 */
export type IsolationKindName = "direct" | "docker" | "compose" | "devcontainer";

/**
 * Lifecycle classification for a compute kind.
 *
 * - `persistent`: the compute target points at long-lived infrastructure (a
 *   host, a VM, a fleet). The DB row models real state -- `status` is
 *   meaningful, sessions reuse the same target, deleting the row implies
 *   tearing down infrastructure.
 *
 * - `template`: the compute target is just a config blueprint (which cluster,
 *   which namespace, which image). The DB row carries no infrastructure state
 *   -- every session spawns its own pod / container / microVM and tears it
 *   down on cleanup. The "row" itself can be ephemeral and is safe to
 *   garbage-collect when no sessions reference it.
 *
 * Local + EC2 + remote-arkd are persistent. Docker/compose/devcontainer/k8s/
 * k8s-kata/firecracker are templates -- their per-session workload (container,
 * pod, microVM) is the real lifecycle, not the target row.
 */
export type ComputeLifecycle = "persistent" | "template";

/** Lifecycle for each compute kind. Drives target-row GC + status semantics. */
export const COMPUTE_KIND_LIFECYCLE: Record<ComputeKindName, ComputeLifecycle> = {
  local: "persistent",
  ec2: "persistent",
  firecracker: "template",
  k8s: "template",
  "k8s-kata": "template",
};

/** Lifecycle for each isolation kind. Used when the compute kind is `local`. */
export const ISOLATION_KIND_LIFECYCLE: Record<IsolationKindName, ComputeLifecycle> = {
  direct: "persistent", // runs on the host
  docker: "template", // container per session
  compose: "template", // compose project per session
  devcontainer: "template", // container per session
};

/**
 * Resolve the effective lifecycle for a (compute, isolation) pair.
 *
 * Rule: a target is `persistent` only when both axes are persistent.
 * - local + direct -> persistent (the host)
 * - local + docker -> template (container per session)
 * - ec2 + direct -> persistent (the VM)
 * - k8s + direct -> template (pod per session)
 *
 * Used by repositories + scheduler to decide whether the compute row should
 * stick around after the last referencing session ends.
 */
export function effectiveLifecycle(compute: ComputeKindName, isolation: IsolationKindName): ComputeLifecycle {
  if (COMPUTE_KIND_LIFECYCLE[compute] === "template") return "template";
  return ISOLATION_KIND_LIFECYCLE[isolation];
}

export interface LocalComputeConfig {
  [key: string]: unknown;
}

export interface EC2ComputeConfig {
  ip?: string;
  key_path?: string;
  instance_id?: string;
  size?: string;
  region?: string;
  ami?: string;
  ssh_user?: string;
  [key: string]: unknown;
}

export interface DockerComputeConfig {
  image?: string;
  container_id?: string;
  [key: string]: unknown;
}

export interface RemoteArkdConfig {
  ip?: string;
  key_path?: string;
  ssh_user?: string;
  arkd_port?: number;
  [key: string]: unknown;
}

export type ComputeConfig = LocalComputeConfig | EC2ComputeConfig | DockerComputeConfig | RemoteArkdConfig;

export interface Compute {
  name: string;
  /** Where the compute lives (dispatch axis). */
  compute_kind: ComputeKindName;
  /** How the agent process is sandboxed (dispatch axis). */
  isolation_kind: IsolationKindName;
  status: ComputeStatus;
  config: ComputeConfig;
  /**
   * When true, this row is a reusable config blueprint -- the dispatcher
   * clones it into a concrete per-session row rather than launching it
   * directly. Template and concrete rows live in the same table,
   * distinguished only by this flag.
   */
  is_template?: boolean;
  /**
   * When set, this row was cloned from the named template at dispatch time.
   * GC treats rows with `cloned_from` as ephemeral regardless of lifecycle.
   */
  cloned_from?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateComputeOpts {
  name: string;
  /** Compute axis (e.g. "local", "ec2"). */
  compute?: ComputeKindName;
  /** Isolation axis (e.g. "direct", "docker"). */
  isolation?: IsolationKindName;
  config?: Partial<ComputeConfig>;
  /** Apply a named template's defaults before user config overrides. */
  template?: string;
  /** Mark this row as a reusable config blueprint instead of a concrete target. */
  is_template?: boolean;
  /** Mark this row as cloned from the named template (set by the dispatcher). */
  cloned_from?: string;
}
