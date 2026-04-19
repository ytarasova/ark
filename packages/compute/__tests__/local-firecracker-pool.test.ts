/**
 * LocalFirecrackerPool unit tests.
 *
 * We exercise the pool's acquire / release / autoscale / stop logic against
 * a real `FirecrackerCompute` wired up through its dependency-injection
 * surface (same pattern as `firecracker-compute.test.ts`). No real
 * firecracker binary or network setup -- every side effect is stubbed.
 *
 * Coverage checklist:
 *   - start() pre-warms `target` VMs
 *   - start() is idempotent
 *   - acquire() pops warm; empty pool falls through to provision()
 *   - stats() reflects warm / inUse counts
 *   - release() calls restore() on snapshot-capable computes and requeues
 *   - release() falls back to stop/start when restore throws NotSupportedError
 *   - release() destroys when we're above `max`
 *   - release() of an unknown handle is a safe no-op (best-effort destroy)
 *   - autoscale grows on high utilization (>= growAbove)
 *   - autoscale shrinks on low utilization (<= shrinkBelow) after idle window
 *   - autoscale respects min / max bounds
 *   - stop() destroys warm + in-use handles and clears the tick
 *   - config validation catches bad min/max/target/thresholds
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { FirecrackerCompute, type FirecrackerComputeDeps, type FirecrackerMeta } from "../core/firecracker/compute.js";
import { LocalFirecrackerPool } from "../core/pool/local-firecracker-pool.js";
import type { PoolConfig } from "../core/pool/types.js";
import { NotSupportedError } from "../core/types.js";
import type { FirecrackerVm, FirecrackerVmSpec, SnapshotArtifacts, SnapshotOpts } from "../core/firecracker/vm.js";

// ── Fake VM (same shape as in firecracker-compute.test.ts) ─────────────────

class FakeVm implements FirecrackerVm {
  readonly spec: FirecrackerVmSpec;
  readonly socketPath: string;
  readonly pid: number | null = 4242;
  readonly calls: string[] = [];

  constructor(spec: FirecrackerVmSpec) {
    this.spec = spec;
    this.socketPath = `/fake/sock/${spec.id}.sock`;
  }

  async start(): Promise<void> {
    this.calls.push("start");
  }
  async stop(): Promise<void> {
    this.calls.push("stop");
  }
  async pause(): Promise<void> {
    this.calls.push("pause");
  }
  async resume(): Promise<void> {
    this.calls.push("resume");
  }
  async snapshot(opts: SnapshotOpts): Promise<SnapshotArtifacts> {
    this.calls.push("snapshot");
    return { memFilePath: opts.memFilePath, stateFilePath: opts.stateFilePath };
  }
  async restore(_: SnapshotArtifacts): Promise<void> {
    this.calls.push("restore");
  }
  async getGuestIp(): Promise<string | null> {
    return null;
  }
}

// ── Compute factory ────────────────────────────────────────────────────────
//
// We hand back the compute, plus a call log that tests can assert against.

interface Harness {
  compute: FirecrackerCompute;
  stats: {
    provisions: number;
    destroys: number;
    snapshots: number;
    restores: number;
    starts: number;
    stops: number;
  };
  vms: FakeVm[];
}

function makeHarness(
  opts: { snapshotCapable?: boolean; restoreBehaviour?: "ok" | "notSupported" | "throw" } = {},
): Harness {
  const snapshotCapable = opts.snapshotCapable ?? true;
  const restoreBehaviour = opts.restoreBehaviour ?? "ok";
  const vms: FakeVm[] = [];
  const stats = { provisions: 0, destroys: 0, snapshots: 0, restores: 0, starts: 0, stops: 0 };

  const deps: FirecrackerComputeDeps = {
    isFirecrackerAvailable: () => ({ ok: true }),
    ensureRootfs: async () => ({ kernelPath: "/fake/kernel", rootfsPath: "/fake/rootfs" }),
    ensureBridge: async () => {},
    createTap: async () => {},
    removeTap: async () => {},
    assignGuestIp: async () => ({
      hostIp: "192.168.127.1",
      guestIp: "192.168.127.2",
      mask: "255.255.255.252",
      prefixLen: 30,
    }),
    createVm: (spec) => {
      const vm = new FakeVm(spec);
      vms.push(vm);
      return vm;
    },
    waitForArkdReady: async () => {},
  };

  const compute = new FirecrackerCompute(deps);

  // Flip capabilities for the "no snapshot" path. Cast through unknown since
  // `capabilities` is readonly on the interface.
  if (!snapshotCapable) {
    (
      compute as unknown as {
        capabilities: { snapshot: boolean; pool: boolean; networkIsolation: boolean; provisionLatency: string };
      }
    ).capabilities = {
      snapshot: false,
      pool: true,
      networkIsolation: true,
      provisionLatency: "seconds",
    };
  }

  // Wrap the compute's public lifecycle methods to count calls + inject
  // custom restore behaviours. We don't stub the underlying compute -- we
  // want the real provision / snapshot / destroy / start / stop code paths
  // to run against the fake VMs so tests exercise the system under test,
  // not a mock of it.
  const originalProvision = compute.provision.bind(compute);
  compute.provision = async (provisionOpts) => {
    stats.provisions += 1;
    return originalProvision(provisionOpts);
  };

  const originalDestroy = compute.destroy.bind(compute);
  compute.destroy = async (h) => {
    stats.destroys += 1;
    return originalDestroy(h);
  };

  const originalSnapshot = compute.snapshot.bind(compute);
  compute.snapshot = async (h) => {
    stats.snapshots += 1;
    return originalSnapshot(h);
  };

  const originalStart = compute.start.bind(compute);
  compute.start = async (h) => {
    stats.starts += 1;
    return originalStart(h);
  };
  const originalStop = compute.stop.bind(compute);
  compute.stop = async (h) => {
    stats.stops += 1;
    return originalStop(h);
  };

  const originalRestore = compute.restore.bind(compute);
  compute.restore = async (s) => {
    stats.restores += 1;
    if (restoreBehaviour === "notSupported") throw new NotSupportedError("firecracker", "restore");
    if (restoreBehaviour === "throw") throw new Error("restore blew up");
    return originalRestore(s);
  };

  return { compute, stats, vms };
}

// ── Default config helper ──────────────────────────────────────────────────

function cfg(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    min: 0,
    max: 4,
    target: 2,
    idleTimeoutMs: 50,
    scaleIntervalMs: 0, // disable autoscale by default; tests that want it enable explicitly
    utilizationThresholds: { growAbove: 0.75, shrinkBelow: 0.25 },
    ...overrides,
  };
}

// ── Test lifecycle ─────────────────────────────────────────────────────────

let pool: LocalFirecrackerPool | null = null;

afterEach(async () => {
  if (pool) {
    await pool.stop();
    pool = null;
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("LocalFirecrackerPool construction", () => {
  it("exposes kind, compute, capacity", () => {
    const { compute } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ min: 1, max: 4, target: 2 }));
    expect(pool.kind).toBe("local-firecracker-pool");
    expect(pool.compute).toBe(compute);
    expect(pool.capacity).toEqual({ min: 1, max: 4, target: 2 });
  });

  it("rejects configs where target is outside [min, max]", () => {
    const { compute } = makeHarness();
    expect(() => new LocalFirecrackerPool(compute, cfg({ min: 2, max: 3, target: 5 }))).toThrow(/target/);
    expect(() => new LocalFirecrackerPool(compute, cfg({ min: 2, max: 3, target: 1 }))).toThrow(/target/);
  });

  it("rejects configs where max < min", () => {
    const { compute } = makeHarness();
    expect(() => new LocalFirecrackerPool(compute, cfg({ min: 4, max: 2, target: 2 }))).toThrow(/max/);
  });

  it("rejects configs where growAbove <= shrinkBelow", () => {
    const { compute } = makeHarness();
    expect(
      () => new LocalFirecrackerPool(compute, cfg({ utilizationThresholds: { growAbove: 0.3, shrinkBelow: 0.5 } })),
    ).toThrow(/growAbove/);
  });
});

describe("start()", () => {
  it("pre-warms `target` VMs and snapshots each baseline", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ target: 3, min: 0, max: 5 }));
    await pool.start();

    expect(stats.provisions).toBe(3);
    expect(stats.snapshots).toBe(3);
    expect(pool.stats()).toEqual({ warm: 3, inUse: 0, total: 3 });
  });

  it("is idempotent -- a second call is a no-op", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ target: 2 }));
    await pool.start();
    await pool.start();
    expect(stats.provisions).toBe(2);
  });

  it("continues after a partial pre-warm failure", async () => {
    // Make every 2nd provision fail to simulate a transient error during warmup.
    const harness = makeHarness();
    let calls = 0;
    const realProvision = harness.compute.provision.bind(harness.compute);
    harness.compute.provision = async (opts) => {
      calls += 1;
      if (calls === 2) throw new Error("transient provision failure");
      return realProvision(opts);
    };

    pool = new LocalFirecrackerPool(harness.compute, cfg({ target: 3, min: 0, max: 5 }));
    await pool.start();
    // 2 out of 3 should have landed.
    expect(pool.stats().warm).toBe(2);
  });
});

describe("acquire()", () => {
  it("pops a warm handle when available (no extra provision)", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ target: 2 }));
    await pool.start();
    const provisionsAfterStart = stats.provisions;

    const handle = await pool.acquire({});
    expect(handle.kind).toBe("firecracker");
    expect(stats.provisions).toBe(provisionsAfterStart); // no extra provision
    expect(pool.stats()).toEqual({ warm: 1, inUse: 1, total: 2 });
  });

  it("falls through to provision() on a cold pool", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ target: 0, min: 0, max: 4 }));
    await pool.start();
    expect(stats.provisions).toBe(0);

    const handle = await pool.acquire({});
    expect(handle.kind).toBe("firecracker");
    expect(stats.provisions).toBe(1);
    expect(pool.stats()).toEqual({ warm: 0, inUse: 1, total: 1 });
  });

  it("hands out each warm handle exactly once", async () => {
    const { compute } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ target: 3 }));
    await pool.start();

    const a = await pool.acquire({});
    const b = await pool.acquire({});
    const c = await pool.acquire({});
    const names = new Set([a.name, b.name, c.name]);
    expect(names.size).toBe(3);
    expect(pool.stats()).toEqual({ warm: 0, inUse: 3, total: 3 });
  });
});

describe("release() with snapshot-capable compute", () => {
  it("calls restore() and requeues the handle into warm", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ target: 1 }));
    await pool.start();

    const handle = await pool.acquire({});
    const restoresBefore = stats.restores;
    await pool.release(handle);

    expect(stats.restores).toBe(restoresBefore + 1);
    expect(pool.stats()).toEqual({ warm: 1, inUse: 0, total: 1 });
  });

  it("keeps the baseline snapshot so repeat release() uses restore every time", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ target: 1 }));
    await pool.start();

    let handle = await pool.acquire({});
    await pool.release(handle);
    const restoresAfterFirst = stats.restores;

    handle = await pool.acquire({});
    await pool.release(handle);
    expect(stats.restores).toBe(restoresAfterFirst + 1);
  });
});

describe("release() fallbacks", () => {
  it("falls back to stop/start when restore throws NotSupportedError", async () => {
    const { compute, stats } = makeHarness({ restoreBehaviour: "notSupported" });
    pool = new LocalFirecrackerPool(compute, cfg({ target: 1 }));
    await pool.start();

    const handle = await pool.acquire({});
    const startsBefore = stats.starts;
    const stopsBefore = stats.stops;
    await pool.release(handle);

    expect(stats.stops).toBe(stopsBefore + 1);
    expect(stats.starts).toBe(startsBefore + 1);
    expect(pool.stats()).toEqual({ warm: 1, inUse: 0, total: 1 });
  });

  it("uses stop/start rewinds when the compute declares no snapshot capability", async () => {
    const { compute, stats } = makeHarness({ snapshotCapable: false });
    pool = new LocalFirecrackerPool(compute, cfg({ target: 1 }));
    await pool.start();

    // With snapshot: false, start() should have skipped the baseline capture.
    expect(stats.snapshots).toBe(0);

    const handle = await pool.acquire({});
    await pool.release(handle);

    expect(stats.restores).toBe(0);
    expect(stats.stops).toBeGreaterThan(0);
    expect(stats.starts).toBeGreaterThan(0);
    expect(pool.stats().warm).toBe(1);
  });

  it("destroys the handle when restore throws an unexpected error", async () => {
    const { compute, stats } = makeHarness({ restoreBehaviour: "throw" });
    pool = new LocalFirecrackerPool(compute, cfg({ target: 1 }));
    await pool.start();

    const handle = await pool.acquire({});
    const destroysBefore = stats.destroys;
    await pool.release(handle);
    expect(stats.destroys).toBeGreaterThan(destroysBefore);
    expect(pool.stats()).toEqual({ warm: 0, inUse: 0, total: 0 });
  });

  it("destroys on release() when the pool is already at max", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ target: 2, min: 0, max: 2 }));
    await pool.start();

    // Acquire and release without changing pool size; then manually bump the pool
    // past max by provisioning through acquire (fall-through path). To simulate
    // that, drain the warm queue first.
    const h1 = await pool.acquire({});
    const h2 = await pool.acquire({});
    // Both warm entries are now in-use; on-demand acquire goes through provision().
    const h3 = await pool.acquire({});
    expect(pool.stats().total).toBe(3);

    // Releasing h1 while total (3) >= max (2) should destroy rather than requeue.
    const destroysBefore = stats.destroys;
    await pool.release(h1);
    expect(stats.destroys).toBe(destroysBefore + 1);
    expect(pool.stats().warm).toBe(0);

    // Cleanup: release the rest so stop() doesn't race.
    await pool.release(h2);
    await pool.release(h3);
  });

  it("treats release() of an unknown handle as a best-effort destroy", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ target: 0, min: 0, max: 2 }));
    await pool.start();

    const fakeHandle = {
      kind: "firecracker" as const,
      name: "not-from-this-pool",
      meta: {
        firecracker: {
          vmId: "ark-fc-not-from-this-pool",
          socketPath: "/dev/null",
          guestIp: "x",
          hostIp: "x",
          tapName: "t",
          kernelPath: "/k",
          rootfsPath: "/r",
          arkdUrl: "http://x",
        } satisfies FirecrackerMeta,
      },
    };
    const destroysBefore = stats.destroys;
    await pool.release(fakeHandle);
    expect(stats.destroys).toBe(destroysBefore + 1);
    expect(pool.stats()).toEqual({ warm: 0, inUse: 0, total: 0 });
  });
});

describe("autoscale", () => {
  it("grows when utilization >= growAbove", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(
      compute,
      cfg({
        target: 2,
        min: 0,
        max: 4,
        scaleIntervalMs: 0, // we drive the tick manually
        utilizationThresholds: { growAbove: 0.5, shrinkBelow: 0.1 },
      }),
    );
    await pool.start();

    // Check out both warm handles -> utilization 2/2 = 1.0, above growAbove.
    await pool.acquire({});
    await pool.acquire({});
    expect(pool.stats().warm).toBe(0);

    // Drive the tick directly via the private method.
    const provisionsBefore = stats.provisions;
    await (pool as unknown as { autoscaleTick: () => Promise<void> }).autoscaleTick();
    expect(stats.provisions).toBe(provisionsBefore + 1);
    expect(pool.stats()).toEqual({ warm: 1, inUse: 2, total: 3 });
  });

  it("does not grow past `max`", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(
      compute,
      cfg({ target: 2, min: 0, max: 2, utilizationThresholds: { growAbove: 0.1, shrinkBelow: 0.05 } }),
    );
    await pool.start();
    // Already at max -- consume both so utilization is 1.0.
    await pool.acquire({});
    await pool.acquire({});
    const provisionsBefore = stats.provisions;
    await (pool as unknown as { autoscaleTick: () => Promise<void> }).autoscaleTick();
    expect(stats.provisions).toBe(provisionsBefore); // no grow
  });

  it("shrinks when utilization <= shrinkBelow and the idle window has elapsed", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(
      compute,
      cfg({
        target: 3,
        min: 1,
        max: 5,
        idleTimeoutMs: 10,
        utilizationThresholds: { growAbove: 0.9, shrinkBelow: 0.1 },
      }),
    );
    await pool.start();
    expect(pool.stats().total).toBe(3);

    // Sleep past the idle window so the oldest warm is eligible.
    await new Promise((r) => setTimeout(r, 20));

    const destroysBefore = stats.destroys;
    await (pool as unknown as { autoscaleTick: () => Promise<void> }).autoscaleTick();
    expect(stats.destroys).toBe(destroysBefore + 1);
    expect(pool.stats().total).toBe(2);
  });

  it("does not shrink before the idle window has elapsed", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(
      compute,
      cfg({
        target: 2,
        min: 1,
        max: 5,
        idleTimeoutMs: 10_000, // effectively infinite for this test
        utilizationThresholds: { growAbove: 0.9, shrinkBelow: 0.1 },
      }),
    );
    await pool.start();

    const destroysBefore = stats.destroys;
    await (pool as unknown as { autoscaleTick: () => Promise<void> }).autoscaleTick();
    expect(stats.destroys).toBe(destroysBefore);
    expect(pool.stats().total).toBe(2);
  });

  it("does not shrink below `min`", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(
      compute,
      cfg({
        target: 2,
        min: 2,
        max: 5,
        idleTimeoutMs: 1,
        // Very permissive shrink threshold so shrinkBelow triggers even at idle.
        utilizationThresholds: { growAbove: 0.99, shrinkBelow: 0.9 },
      }),
    );
    await pool.start();
    await new Promise((r) => setTimeout(r, 10));

    const destroysBefore = stats.destroys;
    await (pool as unknown as { autoscaleTick: () => Promise<void> }).autoscaleTick();
    await (pool as unknown as { autoscaleTick: () => Promise<void> }).autoscaleTick();
    expect(stats.destroys).toBe(destroysBefore);
    expect(pool.stats().total).toBe(2);
  });

  it("autoscale tick runs on scaleIntervalMs when enabled", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(
      compute,
      cfg({
        target: 1,
        min: 0,
        max: 3,
        scaleIntervalMs: 10,
        utilizationThresholds: { growAbove: 0.5, shrinkBelow: 0.01 },
      }),
    );
    await pool.start();
    await pool.acquire({});
    // Wait for at least one tick to fire.
    await new Promise((r) => setTimeout(r, 40));
    expect(stats.provisions).toBeGreaterThanOrEqual(2); // initial + at least one grow
  });
});

describe("stop()", () => {
  it("destroys warm + in-use handles and clears the tick", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ target: 2, min: 0, max: 4, scaleIntervalMs: 10 }));
    await pool.start();
    await pool.acquire({});
    expect(pool.stats()).toEqual({ warm: 1, inUse: 1, total: 2 });

    await pool.stop();
    expect(stats.destroys).toBe(2);
    expect(pool.stats()).toEqual({ warm: 0, inUse: 0, total: 0 });

    // Mark `pool = null` so afterEach doesn't double-stop.
    pool = null;
  });

  it("is idempotent -- a second stop() is a no-op", async () => {
    const { compute, stats } = makeHarness();
    pool = new LocalFirecrackerPool(compute, cfg({ target: 1 }));
    await pool.start();
    await pool.stop();
    const destroysAfterFirst = stats.destroys;
    await pool.stop();
    expect(stats.destroys).toBe(destroysAfterFirst);
    pool = null;
  });

  it("stop() swallows per-VM destroy errors", async () => {
    const harness = makeHarness();
    pool = new LocalFirecrackerPool(harness.compute, cfg({ target: 2 }));
    await pool.start();

    const realDestroy = harness.compute.destroy.bind(harness.compute);
    let calls = 0;
    harness.compute.destroy = async (h) => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return realDestroy(h);
    };

    await pool.stop();
    expect(pool.stats().total).toBe(0);
    pool = null;
  });
});

describe("AppContext integration", () => {
  it("registerComputePool / getComputePool round-trips by compute kind", async () => {
    const { AppContext, setApp, clearApp } = await import("../../core/app.js");
    const app = await AppContext.forTestAsync();
    try {
      await app.boot();
      setApp(app);

      const { compute } = makeHarness();
      pool = new LocalFirecrackerPool(compute, cfg({ target: 0, min: 0, max: 2 }));
      await pool.start();

      app.registerComputePool(pool);
      expect(app.getComputePool("firecracker")).toBe(pool);
      expect(app.getComputePool("ec2")).toBeNull();
      expect(app.listComputePools()).toContain("firecracker");
    } finally {
      await app.shutdown();
      clearApp();
    }
  });
});
