/**
 * LocalFirecrackerPool -- Phase 4 warm-pool of microVMs on a single host.
 *
 * Why a pool?
 *   Provisioning a cold Firecracker microVM costs ~500ms-2s (rootfs attach,
 *   TAP bring-up, kernel boot, arkd readiness). For short agent sessions
 *   that cost dominates wall-clock. A warm pool pays the provision cost
 *   once per VM and hands out ready-to-go handles in O(10ms).
 *
 * Lifecycle per VM:
 *
 *   1. `start()` pre-warms `target` VMs by calling `compute.provision()`.
 *      Each freshly provisioned VM is then snapshotted -- this captures the
 *      pristine baseline with arkd running. The VM keeps running after the
 *      snapshot; the snapshot is only the cheap-rewind checkpoint.
 *   2. `acquire()` pops a warm VM. If none are available, we fall back to
 *      `compute.provision()` synchronously (the "pool miss" path). The
 *      handle moves from `warm` to `inUse`.
 *   3. `release(handle)` rewinds the VM back to its baseline by calling
 *      `compute.restore(snapshot)`. If restore isn't supported, we fall
 *      back to `stop + start`. The handle re-enters the warm queue.
 *   4. The autoscale tick fires every `scaleIntervalMs`: it grows by 1 when
 *      utilization >= `growAbove`, shrinks by 1 when utilization <= `shrinkBelow`
 *      and the idle window has elapsed.
 *   5. `stop()` destroys every tracked VM and clears the tick.
 *
 * What the pool does NOT do:
 *   - It doesn't persist state across process restarts. A crash leaks VMs
 *     by design -- the conductor has a separate reaper for orphans.
 *   - It doesn't queue acquires when the pool is saturated. If `inUse >=
 *     max`, `acquire()` still falls through to `compute.provision()` and
 *     lets the caller pay the cold-start cost rather than blocking.
 *   - It doesn't pin handles to sessions. The session layer is responsible
 *     for calling `release()` exactly once per acquired handle.
 */

import { logInfo, logWarn } from "../../../core/observability/structured-log.js";
import type { Compute, ComputeHandle, ProvisionOpts, Snapshot } from "../types.js";
import { NotSupportedError } from "../types.js";
import type { FirecrackerCompute } from "../firecracker/compute.js";
import type { ComputePool, PoolConfig, PoolStats } from "./types.js";

/**
 * State tracked for every VM the pool owns. We keep the per-VM snapshot on
 * the entry so a `release()` doesn't need to go look it up.
 */
interface PoolEntry {
  handle: ComputeHandle;
  /** Baseline snapshot captured during `start()` (or after a fresh provision). */
  baseline: Snapshot | null;
  /** When the entry became warm (for idleTimeoutMs checks). */
  warmSince: number;
}

export class LocalFirecrackerPool implements ComputePool<FirecrackerCompute> {
  readonly kind = "local-firecracker-pool";
  readonly compute: FirecrackerCompute;
  private readonly config: PoolConfig;

  /** Warm queue -- FIFO via array (front = oldest warm). */
  private readonly warm: PoolEntry[] = [];
  /** In-use map keyed by `handle.name`. */
  private readonly inUse = new Map<string, PoolEntry>();

  private scaleTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(compute: FirecrackerCompute, config: PoolConfig) {
    validatePoolConfig(config);
    this.compute = compute;
    this.config = config;
  }

  get capacity(): { min: number; max: number; target: number } {
    return { min: this.config.min, max: this.config.max, target: this.config.target };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Pre-warm up to `target` handles. We do this sequentially because
    // Firecracker's network bridge + TAP creation is racy when called
    // concurrently on the same host -- one `ip link add` at a time is the
    // safe default. A future optimization can parallelize this per bridge.
    for (let i = 0; i < this.config.target; i++) {
      try {
        await this.grow();
      } catch (err) {
        logWarn("compute-pool", `pre-warm failed at ${i + 1}/${this.config.target}: ${errMsg(err)}`);
        // Continue -- partial warmup is still useful; acquire() will fall
        // through to on-demand provisioning for misses.
      }
    }

    if (this.config.scaleIntervalMs > 0) {
      this.scaleTimer = setInterval(() => {
        this.autoscaleTick().catch((err) => {
          logWarn("compute-pool", `autoscale tick error: ${errMsg(err)}`);
        });
      }, this.config.scaleIntervalMs);
      // Don't keep the event loop alive for the sake of the pool alone.
      (this.scaleTimer as unknown as { unref?: () => void }).unref?.();
    }

    logInfo("compute-pool", "started", {
      kind: this.kind,
      warm: this.warm.length,
      target: this.config.target,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.scaleTimer) {
      clearInterval(this.scaleTimer);
      this.scaleTimer = null;
    }

    // Destroy warm first, then in-use. Callers that hold an in-use handle
    // are going to see their next call fail, which is the intended
    // behaviour -- `stop()` is not a graceful drain, it's a teardown.
    const entries: PoolEntry[] = [...this.warm, ...this.inUse.values()];
    this.warm.length = 0;
    this.inUse.clear();

    for (const entry of entries) {
      try {
        await this.compute.destroy(entry.handle);
      } catch (err) {
        logWarn("compute-pool", `destroy failed during stop: ${errMsg(err)}`);
      }
    }

    logInfo("compute-pool", "stopped", { kind: this.kind });
  }

  // ── Acquire / release ─────────────────────────────────────────────────

  async acquire(opts: ProvisionOpts): Promise<ComputeHandle> {
    const warm = this.warm.shift();
    if (warm) {
      this.inUse.set(warm.handle.name, warm);
      return warm.handle;
    }

    // Miss -- provision on-demand. This path doesn't get a baseline snapshot
    // because we don't know it's a pool-managed VM at release time; the
    // release handler takes care of capturing one after the fact so the
    // next rewind is cheap.
    const handle = await this.compute.provision(opts);
    const entry: PoolEntry = { handle, baseline: null, warmSince: 0 };
    this.inUse.set(handle.name, entry);
    return handle;
  }

  async release(handle: ComputeHandle): Promise<void> {
    const entry = this.inUse.get(handle.name);
    if (!entry) {
      // Unknown handle -- either a double-release or a handle that didn't
      // come from this pool. Best-effort destroy so we don't leak.
      await safeDestroy(this.compute, handle);
      return;
    }
    this.inUse.delete(handle.name);

    // If we're above `max`, shrink on release rather than re-adding.
    if (this.total() >= this.config.max) {
      await safeDestroy(this.compute, entry.handle);
      return;
    }

    // Rewind strategy: prefer restore if we have a baseline, otherwise
    // stop/start. Restore is ~10ms vs ~1s for a full reboot.
    try {
      if (entry.baseline && this.compute.capabilities.snapshot) {
        const rehydrated = await this.compute.restore(entry.baseline);
        entry.handle = rehydrated;
      } else {
        await this.rewindViaRestart(entry);
      }
    } catch (err) {
      if (err instanceof NotSupportedError) {
        // Compute declared snapshot support but threw NotSupportedError at
        // runtime -- fall back to stop/start and carry on.
        await this.rewindViaRestart(entry);
      } else {
        logWarn("compute-pool", `release rewind failed, destroying: ${errMsg(err)}`);
        await safeDestroy(this.compute, entry.handle);
        return;
      }
    }

    // If we never captured a baseline (on-demand miss path), do so now so
    // the next release is the fast-rewind path.
    if (!entry.baseline) {
      try {
        entry.baseline = await this.compute.snapshot(entry.handle);
      } catch {
        /* snapshot not available -- leave baseline null, next release will
         * take the stop/start path again. Explicit no-op. */
      }
    }

    entry.warmSince = Date.now();
    this.warm.push(entry);
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  stats(): PoolStats {
    return {
      warm: this.warm.length,
      inUse: this.inUse.size,
      total: this.total(),
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private total(): number {
    return this.warm.length + this.inUse.size;
  }

  /**
   * Provision + snapshot a fresh VM and add it to the warm queue. Used by
   * `start()` and by the autoscale tick.
   */
  private async grow(): Promise<void> {
    const handle = await this.compute.provision({});
    let baseline: Snapshot | null = null;
    if (this.compute.capabilities.snapshot) {
      try {
        baseline = await this.compute.snapshot(handle);
      } catch (err) {
        logWarn("compute-pool", `baseline snapshot failed; pool will use stop/start rewinds: ${errMsg(err)}`);
      }
    }
    this.warm.push({ handle, baseline, warmSince: Date.now() });
  }

  /**
   * Remove and destroy the oldest warm handle. Used by the autoscale tick.
   * Returns true if an entry was actually shrunk.
   */
  private async shrink(): Promise<boolean> {
    const entry = this.warm.shift();
    if (!entry) return false;
    await safeDestroy(this.compute, entry.handle);
    return true;
  }

  /**
   * Fallback rewind path used when the compute doesn't support snapshot
   * (or threw NotSupportedError at runtime). stop() pauses the VM, start()
   * resumes it. That's enough for the current Firecracker use-case because
   * `FirecrackerCompute.start/stop` map to pause/resume.
   */
  private async rewindViaRestart(entry: PoolEntry): Promise<void> {
    await this.compute.stop(entry.handle);
    await this.compute.start(entry.handle);
  }

  private async autoscaleTick(): Promise<void> {
    if (!this.started) return;
    const total = this.total();
    if (total === 0) {
      // Nothing to reason about; pre-warm would have logged a failure.
      return;
    }
    const utilization = this.inUse.size / total;
    const { growAbove, shrinkBelow } = this.config.utilizationThresholds;

    if (utilization >= growAbove && total < this.config.max) {
      try {
        await this.grow();
      } catch (err) {
        logWarn("compute-pool", `autoscale grow failed: ${errMsg(err)}`);
      }
      return;
    }

    if (utilization <= shrinkBelow && total > this.config.min) {
      // Only shrink if the oldest warm entry has been idle long enough.
      const oldest = this.warm[0];
      if (!oldest) return;
      const idleFor = Date.now() - oldest.warmSince;
      if (idleFor < this.config.idleTimeoutMs) return;
      await this.shrink();
    }
  }
}

// ── Utility helpers (module-private) ─────────────────────────────────────

function validatePoolConfig(cfg: PoolConfig): void {
  if (cfg.min < 0) throw new Error(`PoolConfig.min must be >= 0 (got ${cfg.min})`);
  if (cfg.max < cfg.min) throw new Error(`PoolConfig.max (${cfg.max}) must be >= min (${cfg.min})`);
  if (cfg.target < cfg.min || cfg.target > cfg.max) {
    throw new Error(`PoolConfig.target (${cfg.target}) must be in [min=${cfg.min}, max=${cfg.max}]`);
  }
  const { growAbove, shrinkBelow } = cfg.utilizationThresholds;
  if (growAbove <= shrinkBelow) {
    throw new Error(`utilizationThresholds.growAbove (${growAbove}) must be > shrinkBelow (${shrinkBelow})`);
  }
  if (growAbove > 1 || shrinkBelow < 0) {
    throw new Error(`utilizationThresholds must be within [0, 1]`);
  }
}

async function safeDestroy(compute: Compute, handle: ComputeHandle): Promise<void> {
  try {
    await compute.destroy(handle);
  } catch (err) {
    logWarn("compute-pool", `destroy failed: ${errMsg(err)}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
