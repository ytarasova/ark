/**
 * ComputeTarget -- the composed (Compute, Runtime) pair used at dispatch.
 *
 * Wave 1 just exposes a straight delegation over the two interfaces. Wave 3
 * rewires the dispatch layer to construct a ComputeTarget from the
 * `{compute_kind, runtime_kind}` DB columns instead of looking up a single
 * `ComputeProvider`.
 *
 * Methods follow the lifecycle order: `provision` (compute) -> `prepare`
 * (runtime) -> `launchAgent` (runtime) -> `shutdown` (runtime) -> `destroy`
 * (compute). The compose shape intentionally does not expose intermediate
 * start/stop yet -- those semantics get refined in Wave 2 once the remote
 * computes land.
 */

import type {
  AgentHandle,
  Compute,
  ComputeHandle,
  LaunchOpts,
  PrepareCtx,
  ProvisionOpts,
  Runtime,
  Snapshot,
} from "./types.js";

export class ComputeTarget {
  constructor(
    readonly compute: Compute,
    readonly runtime: Runtime,
  ) {}

  // ── Compute delegation ────────────────────────────────────────────────

  provision(opts: ProvisionOpts): Promise<ComputeHandle> {
    return this.compute.provision(opts);
  }

  start(h: ComputeHandle): Promise<void> {
    return this.compute.start(h);
  }

  stop(h: ComputeHandle): Promise<void> {
    return this.compute.stop(h);
  }

  destroy(h: ComputeHandle): Promise<void> {
    return this.compute.destroy(h);
  }

  getArkdUrl(h: ComputeHandle): string {
    return this.compute.getArkdUrl(h);
  }

  snapshot(h: ComputeHandle): Promise<Snapshot> {
    return this.compute.snapshot(h);
  }

  restore(s: Snapshot): Promise<ComputeHandle> {
    return this.compute.restore(s);
  }

  // ── Runtime delegation ────────────────────────────────────────────────

  prepare(h: ComputeHandle, ctx: PrepareCtx): Promise<void> {
    return this.runtime.prepare(this.compute, h, ctx);
  }

  launchAgent(h: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle> {
    return this.runtime.launchAgent(this.compute, h, opts);
  }

  shutdown(h: ComputeHandle): Promise<void> {
    return this.runtime.shutdown(this.compute, h);
  }
}
