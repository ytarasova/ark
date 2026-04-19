/**
 * ComputePool -- Phase 4 of the microVM compute vision.
 *
 * A pool wraps a single `Compute` implementation and amortises the
 * provision+boot latency across many short-lived sessions. Today's concrete
 * impl is `LocalFirecrackerPool` (see `./local-firecracker-pool.ts`); future
 * waves add pools for EC2 microVMs, Fly Machines, and Kata pods.
 *
 * Lifecycle:
 *
 *   - `start()`   -- pre-warm `target` handles. Returns once the baseline
 *                    handles are ready to hand out. For snapshot-capable
 *                    computes, `start` takes a pristine baseline snapshot
 *                    the pool can cheaply rewind to on `release`.
 *   - `acquire()` -- pop a warm handle. If the warm queue is empty, fall
 *                    back to on-demand provisioning through the underlying
 *                    compute. Moves the handle from "warm" to "in-use".
 *   - `release()` -- take an in-use handle back. The default rewind
 *                    strategy is `compute.restore(baselineSnapshot)` for
 *                    snapshot-capable computes; pools fall back to
 *                    `stop/start` when restore isn't available. After the
 *                    rewind, the handle is requeued into the warm set.
 *   - `stop()`    -- drain warm + in-use handles, destroy them, clear
 *                    any autoscale timers.
 *
 * Autoscale:
 *
 *   A pool runs a low-frequency tick (`scaleIntervalMs`) that grows the
 *   pool by 1 when utilization is >= `growAbove`, or shrinks it by 1 when
 *   utilization is <= `shrinkBelow`. Shrinking respects `idleTimeoutMs`
 *   so a brief drop in traffic doesn't collapse the pool.
 */

import type { Compute, ComputeHandle, ProvisionOpts } from "../types.js";

// ── Configuration ──────────────────────────────────────────────────────────

/**
 * Pool sizing + scaling knobs. Exposed as a plain config object rather than
 * individual ctor args so future fields (eg. max concurrent launches) can
 * land without bumping the public signature.
 */
export interface PoolConfig {
  /** Floor on `total` -- pool never shrinks below this. */
  readonly min: number;
  /** Ceiling on `total` -- pool never grows above this. */
  readonly max: number;
  /** Desired warm count on `start()` + the steady-state upper bound. */
  readonly target: number;
  /** How long a warm handle may sit idle before being eligible to shrink. */
  readonly idleTimeoutMs: number;
  /** Autoscale tick interval. `0` disables the tick entirely. */
  readonly scaleIntervalMs: number;
  /** Utilization thresholds (`inUse / total`) that trigger grow / shrink. */
  readonly utilizationThresholds: {
    /** Grow when `inUse / total >= growAbove` (0..1). */
    readonly growAbove: number;
    /** Shrink when `inUse / total <= shrinkBelow` (0..1). */
    readonly shrinkBelow: number;
  };
}

/** Sensible defaults for a local, single-host pool. */
export const defaultPoolConfig: PoolConfig = {
  min: 1,
  max: 8,
  target: 2,
  idleTimeoutMs: 60_000,
  scaleIntervalMs: 5_000,
  utilizationThresholds: { growAbove: 0.75, shrinkBelow: 0.25 },
};

// ── Stats ──────────────────────────────────────────────────────────────────

export interface PoolStats {
  /** Warm (idle, ready-to-acquire) handles. */
  warm: number;
  /** Handles currently checked out via `acquire()`. */
  inUse: number;
  /** warm + inUse. */
  total: number;
}

// ── Pool interface ─────────────────────────────────────────────────────────

/**
 * A ComputePool wraps one Compute instance. The type parameter lets callers
 * that want the concrete compute (eg. to reach for a backend-specific helper)
 * keep the strong typing without casting.
 */
export interface ComputePool<C extends Compute = Compute> {
  readonly kind: string;
  readonly compute: C;
  readonly capacity: { min: number; max: number; target: number };

  acquire(opts: ProvisionOpts): Promise<ComputeHandle>;
  release(handle: ComputeHandle): Promise<void>;
  stats(): PoolStats;

  start(): Promise<void>;
  stop(): Promise<void>;
}
