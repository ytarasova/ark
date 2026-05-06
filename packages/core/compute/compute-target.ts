/**
 * ComputeTarget -- the composed (Compute, Isolation) pair used at dispatch.
 *
 * Exposes a straight delegation over the two interfaces. The dispatch layer
 * constructs a ComputeTarget from the `{compute_kind, isolation_kind}` DB
 * columns instead of looking up a single `ComputeProvider`.
 *
 * When the underlying Compute declares `capabilities.pool === true` AND an
 * AppContext is wired in AND that app has a `ComputePool` registered for
 * `compute.kind`, `provision()` acquires from the pool instead of calling
 * `compute.provision()` directly. `destroy()` mirrors this by consulting a
 * lightweight tag (`handle.meta.__pool_source`) stamped at acquire time so we
 * dispose via `pool.release()` iff the handle actually came from the pool.
 * Handles that pre-date pool wiring (or that were provisioned directly even
 * when a pool exists, eg. legacy code paths) continue through
 * `compute.destroy()` as before.
 *
 * Methods follow the lifecycle order: `provision` (compute) -> `prepare`
 * (isolation) -> `launchAgent` (isolation) -> `shutdown` (isolation) ->
 * `destroy` (compute). The compose shape intentionally does not expose
 * intermediate start/stop yet -- those semantics may get refined later
 * once more remote computes land.
 */

import type { AppContext } from "../app.js";
import type {
  AgentHandle,
  Compute,
  ComputeHandle,
  Isolation,
  LaunchOpts,
  PrepareCtx,
  ProvisionOpts,
  Snapshot,
} from "./types.js";
import type { ComputePool } from "./warm-pool/types.js";

/**
 * Meta key stamped on a handle's `meta` bag when it was acquired from a
 * ComputePool. `destroy()` reads it to decide between `pool.release()` and
 * `compute.destroy()`. Exported so tests (and any future tooling that wants
 * to introspect a handle's provenance) can reference the same constant.
 */
export const POOL_SOURCE_META_KEY = "__pool_source";

export class ComputeTarget {
  constructor(
    readonly compute: Compute,
    readonly isolation: Isolation,
    /**
     * Optional AppContext used to consult the compute-pool registry. When
     * absent (legacy direct construction in tests / adapters without an app
     * in scope), pool-consult is disabled and every call falls through to
     * the underlying Compute directly. This keeps pre-Phase-4 behaviour
     * byte-for-byte.
     */
    readonly app?: AppContext,
  ) {}

  // ── Compute delegation ────────────────────────────────────────────────

  async provision(opts: ProvisionOpts): Promise<ComputeHandle> {
    const pool = this.resolvePool();
    if (pool) {
      const handle = await pool.acquire(opts);
      // Tag the handle so `destroy()` routes back to `pool.release()` rather
      // than `compute.destroy()`. We mutate the `meta` bag in place because
      // `meta` itself is `readonly` on ComputeHandle but its contents are
      // not -- this mirrors how every Compute impl already populates
      // `meta.<backend>` on provision.
      (handle.meta as Record<string, unknown>)[POOL_SOURCE_META_KEY] = pool.kind;
      return handle;
    }
    return this.compute.provision(opts);
  }

  start(h: ComputeHandle): Promise<void> {
    return this.compute.start(h);
  }

  stop(h: ComputeHandle): Promise<void> {
    return this.compute.stop(h);
  }

  async destroy(h: ComputeHandle): Promise<void> {
    const poolSource = h.meta?.[POOL_SOURCE_META_KEY];
    if (typeof poolSource === "string") {
      const pool = this.resolvePool();
      // Only release back to the pool if the currently-registered pool is
      // the same one that originally handed out this handle. A mismatch
      // (pool replaced / deregistered mid-session) is treated as a safety
      // net: fall through to compute.destroy() rather than release into an
      // unrelated pool that doesn't know this handle.
      if (pool && pool.kind === poolSource) {
        await pool.release(h);
        return;
      }
    }
    await this.compute.destroy(h);
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

  // ── Isolation delegation ──────────────────────────────────────────────

  prepare(h: ComputeHandle, ctx: PrepareCtx): Promise<void> {
    return this.isolation.prepare(this.compute, h, ctx);
  }

  launchAgent(h: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle> {
    return this.isolation.launchAgent(this.compute, h, opts);
  }

  shutdown(h: ComputeHandle): Promise<void> {
    return this.isolation.shutdown(this.compute, h);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Resolve the pool to consult for this target, or null if pool-consult is
   * off. Off means any of: no app wired in, Compute doesn't advertise pool
   * support, or no pool registered for this compute kind.
   */
  private resolvePool(): ComputePool | null {
    if (!this.app) return null;
    if (!this.compute.capabilities.pool) return null;
    return this.app.getComputePool(this.compute.kind);
  }
}
