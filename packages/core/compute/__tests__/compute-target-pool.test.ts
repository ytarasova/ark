/**
 * ComputeTarget pool-consult tests.
 *
 * The pool-consult layer sits between ComputeTarget.provision/destroy and the
 * underlying Compute. It's entirely governed by three inputs:
 *
 *   - `compute.capabilities.pool` -- does the compute want pooling at all?
 *   - `app.getComputePool(kind)`  -- is a pool actually registered?
 *   - `handle.meta.__pool_source` -- was this handle acquired from a pool?
 *
 * Every test here pins one of those inputs and asserts the right routing
 * happens. We use a stub `Compute` + stub `ComputePool` so we can count calls
 * without any real backend behaviour.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { AppContext } from "../../app.js";
import { clearApp, setApp } from "../../__tests__/test-helpers.js";
import { ComputeTarget, POOL_SOURCE_META_KEY } from "../compute-target.js";
import type { ComputePool, PoolStats } from "../warm-pool/types.js";
import type {
  AgentHandle,
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  LaunchOpts,
  PrepareCtx,
  ProvisionOpts,
  Runtime,
  Snapshot,
} from "../types.js";

// ── Stubs ──────────────────────────────────────────────────────────────────

class StubCompute implements Compute {
  readonly kind: ComputeKind;
  readonly capabilities: ComputeCapabilities;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(kind: ComputeKind, capabilities: ComputeCapabilities) {
    this.kind = kind;
    this.capabilities = capabilities;
  }

  async provision(opts: ProvisionOpts): Promise<ComputeHandle> {
    this.calls.push({ method: "provision", args: [opts] });
    return { kind: this.kind, name: `direct-${this.calls.length}`, meta: { source: "direct" } };
  }
  async start(h: ComputeHandle): Promise<void> {
    this.calls.push({ method: "start", args: [h] });
  }
  async stop(h: ComputeHandle): Promise<void> {
    this.calls.push({ method: "stop", args: [h] });
  }
  async destroy(h: ComputeHandle): Promise<void> {
    this.calls.push({ method: "destroy", args: [h] });
  }
  getArkdUrl(_h: ComputeHandle): string {
    return "http://stub:0";
  }
  async snapshot(_h: ComputeHandle): Promise<Snapshot> {
    return { id: "s", computeKind: this.kind, createdAt: "", sizeBytes: 0, metadata: {} };
  }
  async restore(_s: Snapshot): Promise<ComputeHandle> {
    return { kind: this.kind, name: "restored", meta: {} };
  }
}

class StubRuntime implements Runtime {
  readonly kind = "direct" as const;
  readonly name = "stub-runtime";
  async prepare(_c: Compute, _h: ComputeHandle, _ctx: PrepareCtx): Promise<void> {}
  async launchAgent(_c: Compute, _h: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle> {
    return { sessionName: opts.tmuxName };
  }
  async shutdown(_c: Compute, _h: ComputeHandle): Promise<void> {}
}

/**
 * Stub pool that records every acquire/release and hands out handles
 * deterministically. `kind` is what ends up in `handle.meta.__pool_source`.
 */
class StubPool implements ComputePool {
  readonly kind: string;
  readonly compute: Compute;
  readonly capacity = { min: 0, max: 4, target: 0 };
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private nextId = 0;

  constructor(compute: Compute, kind: string = "stub-pool") {
    this.compute = compute;
    this.kind = kind;
  }

  async acquire(opts: ProvisionOpts): Promise<ComputeHandle> {
    this.calls.push({ method: "acquire", args: [opts] });
    this.nextId += 1;
    return { kind: this.compute.kind, name: `pool-${this.nextId}`, meta: { source: "pool" } };
  }
  async release(handle: ComputeHandle): Promise<void> {
    this.calls.push({ method: "release", args: [handle] });
  }
  stats(): PoolStats {
    return { warm: 0, inUse: 0, total: 0 };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

const poolCaps: ComputeCapabilities = {
  snapshot: true,
  pool: true,
  networkIsolation: false,
  provisionLatency: "instant",
};

const noPoolCaps: ComputeCapabilities = {
  snapshot: false,
  pool: false,
  networkIsolation: false,
  provisionLatency: "instant",
};

// ── Fixture ────────────────────────────────────────────────────────────────

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterEach(async () => {
  await app.shutdown();
  clearApp();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ComputeTarget pool-consult", async () => {
  it("provision acquires from the pool and does NOT call compute.provision when capabilities.pool is true and a pool is registered", async () => {
    const compute = new StubCompute("local", poolCaps);
    const pool = new StubPool(compute);
    app.registerComputePool(pool);

    const target = new ComputeTarget(compute, new StubRuntime(), app);
    const handle = await target.provision({ tags: { name: "t1" } });

    expect(pool.calls.map((c) => c.method)).toEqual(["acquire"]);
    expect(compute.calls.map((c) => c.method)).toEqual([]);
    expect(handle.name).toBe("pool-1");
    expect(handle.meta[POOL_SOURCE_META_KEY]).toBe(pool.kind);
  });

  it("destroy releases to the pool and does NOT call compute.destroy when the handle was pool-sourced", async () => {
    const compute = new StubCompute("local", poolCaps);
    const pool = new StubPool(compute);
    app.registerComputePool(pool);

    const target = new ComputeTarget(compute, new StubRuntime(), app);
    const handle = await target.provision({});
    await target.destroy(handle);

    expect(pool.calls.map((c) => c.method)).toEqual(["acquire", "release"]);
    expect(compute.calls.map((c) => c.method)).toEqual([]);
  });

  it("provision bypasses the pool and calls compute.provision directly when capabilities.pool is false", async () => {
    const compute = new StubCompute("local", noPoolCaps);
    const pool = new StubPool(compute);
    // Register the pool even though the compute says it doesn't want one --
    // the flag is authoritative, not the registry.
    app.registerComputePool(pool);

    const target = new ComputeTarget(compute, new StubRuntime(), app);
    const handle = await target.provision({});

    expect(compute.calls.map((c) => c.method)).toEqual(["provision"]);
    expect(pool.calls.map((c) => c.method)).toEqual([]);
    expect(handle.meta[POOL_SOURCE_META_KEY]).toBeUndefined();
  });

  it("provision falls through to compute.provision when capabilities.pool is true but no pool is registered", async () => {
    const compute = new StubCompute("local", poolCaps);
    // Notably: we never call app.registerComputePool.

    const target = new ComputeTarget(compute, new StubRuntime(), app);
    const handle = await target.provision({});

    expect(compute.calls.map((c) => c.method)).toEqual(["provision"]);
    expect(handle.meta[POOL_SOURCE_META_KEY]).toBeUndefined();
  });

  it("destroy calls compute.destroy for handles that were NOT pool-sourced, even when a pool is registered (legacy-handle safety net)", async () => {
    const compute = new StubCompute("local", poolCaps);
    const pool = new StubPool(compute);
    app.registerComputePool(pool);

    const target = new ComputeTarget(compute, new StubRuntime(), app);
    // Synthesise a "legacy" handle -- no __pool_source stamp.
    const legacyHandle: ComputeHandle = { kind: "local", name: "legacy-handle", meta: {} };

    await target.destroy(legacyHandle);

    expect(compute.calls.map((c) => c.method)).toEqual(["destroy"]);
    expect(pool.calls.map((c) => c.method)).toEqual([]);
  });

  it("pool-consult is off when ComputeTarget is constructed WITHOUT an AppContext (legacy construction)", async () => {
    const compute = new StubCompute("local", poolCaps);
    const pool = new StubPool(compute);
    app.registerComputePool(pool);

    // Legacy construction path: no app parameter.
    const target = new ComputeTarget(compute, new StubRuntime());
    const handle = await target.provision({});
    await target.destroy(handle);

    expect(compute.calls.map((c) => c.method)).toEqual(["provision", "destroy"]);
    expect(pool.calls.map((c) => c.method)).toEqual([]);
  });

  it("destroy falls back to compute.destroy when the handle is tagged but the pool is no longer registered", async () => {
    const compute = new StubCompute("local", poolCaps);
    const pool = new StubPool(compute);
    app.registerComputePool(pool);

    const target = new ComputeTarget(compute, new StubRuntime(), app);
    const handle = await target.provision({});
    expect(handle.meta[POOL_SOURCE_META_KEY]).toBe(pool.kind);

    // Drop the pool from the registry (simulating a process restart / pool
    // replacement / explicit deregistration) while holding a live handle.
    // The tag is still there but there's no pool to release to.
    app.deregisterComputePool(compute.kind);

    await target.destroy(handle);

    expect(compute.calls.map((c) => c.method)).toEqual(["destroy"]);
    // The release never happened because the pool was gone by destroy time.
    expect(pool.calls.map((c) => c.method)).toEqual(["acquire"]);
  });

  it("destroy falls back to compute.destroy when the handle tag references a DIFFERENT pool than is currently registered", async () => {
    const compute = new StubCompute("local", poolCaps);
    // Original pool the handle came from.
    const originalPool = new StubPool(compute, "original-pool");
    app.registerComputePool(originalPool);

    const target = new ComputeTarget(compute, new StubRuntime(), app);
    const handle = await target.provision({});
    expect(handle.meta[POOL_SOURCE_META_KEY]).toBe("original-pool");

    // Swap in a different pool registered under the same compute kind --
    // mismatch means we must NOT release a handle this pool didn't produce.
    const replacementPool = new StubPool(compute, "replacement-pool");
    app.registerComputePool(replacementPool);

    await target.destroy(handle);

    expect(compute.calls.map((c) => c.method)).toEqual(["destroy"]);
    expect(originalPool.calls.map((c) => c.method)).toEqual(["acquire"]);
    expect(replacementPool.calls.map((c) => c.method)).toEqual([]);
  });

  it("pool registered under a DIFFERENT compute kind does not trigger pool-consult", async () => {
    // The compute is kind=local but the pool is registered under kind=firecracker.
    // getComputePool('local') returns null, so we go direct.
    const compute = new StubCompute("local", poolCaps);
    const otherCompute = new StubCompute("firecracker", poolCaps);
    const pool = new StubPool(otherCompute);
    app.registerComputePool(pool);

    const target = new ComputeTarget(compute, new StubRuntime(), app);
    const handle = await target.provision({});

    expect(compute.calls.map((c) => c.method)).toEqual(["provision"]);
    expect(pool.calls.map((c) => c.method)).toEqual([]);
    expect(handle.meta[POOL_SOURCE_META_KEY]).toBeUndefined();
  });

  it("multiple provision/destroy cycles stay routed through the pool", async () => {
    const compute = new StubCompute("local", poolCaps);
    const pool = new StubPool(compute);
    app.registerComputePool(pool);

    const target = new ComputeTarget(compute, new StubRuntime(), app);

    const h1 = await target.provision({});
    const h2 = await target.provision({});
    const h3 = await target.provision({});
    await target.destroy(h2);
    await target.destroy(h1);
    await target.destroy(h3);

    expect(pool.calls.map((c) => c.method)).toEqual(["acquire", "acquire", "acquire", "release", "release", "release"]);
    expect(compute.calls.map((c) => c.method)).toEqual([]);
  });
});
