/**
 * Compute.flushPlacement tests.
 *
 * Wiring-level coverage: each Compute kind constructs the right
 * provider-medium PlacementCtx for its handle, and the deferred queue's
 * `flush()` method is invoked exactly once with that ctx. The placement-ctx
 * classes themselves have their own dedicated tests (see
 * `packages/compute/ec2/__tests__/placement-ctx.test.ts` and
 * `packages/core/secrets/__tests__/deferred-placement-ctx.test.ts`); this
 * file's job is to verify the new Compute.flushPlacement entry point picks
 * the right ctx for each kind and threads queued ops onto it.
 *
 * Each test injects a stub PlacementCtx via the `setPlacementCtxFactoryForTesting`
 * seam so we don't reach for real ssh / kubectl / fs.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import { LocalCompute } from "../local.js";
import { EC2Compute, type EC2HandleMeta } from "../ec2/compute.js";
import { K8sCompute, type K8sHandleMeta } from "../k8s.js";
import { KataCompute } from "../k8s-kata.js";
import { FirecrackerCompute, type FirecrackerMeta } from "../firecracker/compute.js";
import { DeferredPlacementCtx } from "../../secrets/deferred-placement-ctx.js";
import type { PlacementCtx } from "../../secrets/placement-types.js";
import type { ComputeHandle } from "../types.js";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

// ── Recording stub PlacementCtx ─────────────────────────────────────────────

interface RecordingCtx extends PlacementCtx {
  writeCalls: Array<{ path: string; mode: number; bytes: Uint8Array }>;
  appendCalls: Array<{ path: string; marker: string; bytes: Uint8Array }>;
  envCalls: Array<{ key: string; value: string }>;
  provisionerCalls: Array<{ kubeconfig?: Uint8Array }>;
}

function makeRecordingCtx(): RecordingCtx {
  const env: Record<string, string> = {};
  const ctx: RecordingCtx = {
    writeCalls: [],
    appendCalls: [],
    envCalls: [],
    provisionerCalls: [],
    async writeFile(path, mode, bytes) {
      ctx.writeCalls.push({ path, mode, bytes });
    },
    async appendFile(path, marker, bytes) {
      ctx.appendCalls.push({ path, marker, bytes });
    },
    setEnv(key, value) {
      env[key] = value;
      ctx.envCalls.push({ key, value });
    },
    setProvisionerConfig(cfg) {
      ctx.provisionerCalls.push(cfg);
    },
    expandHome(rel) {
      return rel.startsWith("~/") ? `/test-home/${rel.slice(2)}` : rel;
    },
    getEnv() {
      return { ...env };
    },
  };
  return ctx;
}

// ── Handle factories ────────────────────────────────────────────────────────

function ec2Handle(overrides: Partial<EC2HandleMeta> = {}): ComputeHandle {
  const meta: EC2HandleMeta = {
    instanceId: "i-abc123",
    publicIp: null,
    privateIp: null,
    arkdLocalPort: 54321,
    portForwardPid: 1111,
    region: "us-east-1",
    awsProfile: "ark-test",
    stackName: "ark-compute-ec2-test",
    size: "m",
    arch: "x64",
    ...overrides,
  };
  return { kind: "ec2", name: "ec2-test", meta: { ec2: meta } };
}

function k8sHandle(overrides: Partial<K8sHandleMeta> = {}): ComputeHandle {
  const meta: K8sHandleMeta = {
    podName: "ark-test-pod",
    namespace: "ark",
    portForwardPid: 2222,
    arkdLocalPort: 33333,
    ...overrides,
  };
  return { kind: "k8s", name: "k8s-test", meta: { k8s: meta } };
}

function kataHandle(overrides: Partial<K8sHandleMeta> = {}): ComputeHandle {
  return { ...k8sHandle(overrides), kind: "k8s-kata", name: "kata-test" };
}

function fcHandle(overrides: Partial<FirecrackerMeta> = {}): ComputeHandle {
  const meta: FirecrackerMeta = {
    vmId: "ark-fc-test",
    socketPath: "/tmp/fc.sock",
    guestIp: "172.17.0.2",
    hostIp: "172.17.0.1",
    tapName: "fc-tap0",
    kernelPath: "/tmp/vmlinux",
    rootfsPath: "/tmp/rootfs.ext4",
    arkdUrl: "http://172.17.0.2:19300",
    ...overrides,
  };
  return { kind: "firecracker", name: "fc-test", meta: { firecracker: meta } };
}

// ── LocalCompute ────────────────────────────────────────────────────────────

describe("LocalCompute.flushPlacement", () => {
  test("constructs a LocalPlacementCtx and flushes onto it", async () => {
    const c = new LocalCompute(app);
    const ctx = makeRecordingCtx();
    let factoryCalls = 0;
    c.setPlacementCtxFactoryForTesting(() => {
      factoryCalls++;
      return ctx;
    });

    const deferred = new DeferredPlacementCtx("/test-home");
    await deferred.writeFile("/test-home/.ssh/id_test", 0o600, new Uint8Array([1, 2, 3]));
    deferred.setEnv("FOO", "bar");

    await c.flushPlacement!(
      { kind: "local", name: "local", meta: {} },
      {
        placement: deferred,
        sessionId: "s-test",
      },
    );

    expect(factoryCalls).toBe(1);
    expect(ctx.writeCalls).toHaveLength(1);
    expect(ctx.writeCalls[0].path).toBe("/test-home/.ssh/id_test");
    expect(ctx.writeCalls[0].mode).toBe(0o600);
    // setEnv on the deferred ctx is captured synchronously and is not part
    // of the queue replay; flush() should not surface it onto the target.
    expect(ctx.envCalls).toHaveLength(0);
  });

  test("no-op when the deferred queue is empty (env-only)", async () => {
    const c = new LocalCompute(app);
    let factoryCalls = 0;
    c.setPlacementCtxFactoryForTesting(() => {
      factoryCalls++;
      return makeRecordingCtx();
    });

    const deferred = new DeferredPlacementCtx("/test-home");
    deferred.setEnv("FOO", "bar"); // env only -- queue stays empty

    await c.flushPlacement!(
      { kind: "local", name: "local", meta: {} },
      {
        placement: deferred,
        sessionId: "s-test",
      },
    );

    expect(factoryCalls).toBe(0);
  });
});

// ── EC2Compute ──────────────────────────────────────────────────────────────

describe("EC2Compute.flushPlacement", () => {
  test("constructs an EC2PlacementCtx with fields read from handle.meta.ec2", async () => {
    const c = new EC2Compute(app);
    const ctx = makeRecordingCtx();
    const factoryArgs: Array<Record<string, unknown>> = [];
    c.setPlacementCtxFactoryForTesting((deps) => {
      factoryArgs.push(deps);
      return ctx;
    });

    const deferred = new DeferredPlacementCtx("/home/ubuntu");
    await deferred.writeFile("/home/ubuntu/.ssh/id_x", 0o600, new Uint8Array([42]));
    await deferred.appendFile("/home/ubuntu/.ssh/config", "ark:secret:BB", new Uint8Array([1, 2]));

    await c.flushPlacement!(ec2Handle(), { placement: deferred, sessionId: "s-test" });

    // Right fields plumbed off meta.ec2 into the ctx factory.
    expect(factoryArgs).toHaveLength(1);
    expect(factoryArgs[0]).toEqual({
      instanceId: "i-abc123",
      region: "us-east-1",
      awsProfile: "ark-test",
    });

    // Both queued ops landed on the recording ctx in queue order.
    expect(ctx.writeCalls).toHaveLength(1);
    expect(ctx.writeCalls[0].path).toBe("/home/ubuntu/.ssh/id_x");
    expect(ctx.appendCalls).toHaveLength(1);
    expect(ctx.appendCalls[0].marker).toBe("ark:secret:BB");
  });

  test("no-op when the deferred queue is empty", async () => {
    const c = new EC2Compute(app);
    let factoryCalls = 0;
    c.setPlacementCtxFactoryForTesting(() => {
      factoryCalls++;
      return makeRecordingCtx();
    });

    const deferred = new DeferredPlacementCtx("/home/ubuntu");
    deferred.setEnv("FOO", "bar"); // env only

    await c.flushPlacement!(ec2Handle(), { placement: deferred, sessionId: "s-test" });

    expect(factoryCalls).toBe(0);
  });

  test("throws when ops are queued but instanceId is missing", async () => {
    const c = new EC2Compute(app);
    c.setPlacementCtxFactoryForTesting(() => makeRecordingCtx());

    const deferred = new DeferredPlacementCtx("/home/ubuntu");
    await deferred.writeFile("/x", 0o600, new Uint8Array([1]));

    const handle = ec2Handle({ instanceId: "" });
    await expect(c.flushPlacement!(handle, { placement: deferred, sessionId: "s-test" })).rejects.toThrow(
      /no instanceId at launch time/,
    );
  });
});

// ── K8sCompute ──────────────────────────────────────────────────────────────

describe("K8sCompute.flushPlacement", () => {
  test("constructs a K8sPlacementCtx with namespace + podName from meta.k8s", async () => {
    const c = new K8sCompute(app);
    const ctx = makeRecordingCtx();
    const factoryArgs: Array<Record<string, unknown>> = [];
    c.setPlacementCtxFactoryForTesting((deps) => {
      factoryArgs.push(deps);
      return ctx;
    });

    const deferred = new DeferredPlacementCtx("/root");
    await deferred.writeFile("/root/.kube/config", 0o600, new Uint8Array([7, 8]));

    await c.flushPlacement!(k8sHandle(), { placement: deferred, sessionId: "s-test" });

    expect(factoryArgs).toHaveLength(1);
    expect(factoryArgs[0]).toEqual({ namespace: "ark", podName: "ark-test-pod" });
    expect(ctx.writeCalls).toHaveLength(1);
    expect(ctx.writeCalls[0].path).toBe("/root/.kube/config");
  });

  test("no-op on empty queue", async () => {
    const c = new K8sCompute(app);
    let factoryCalls = 0;
    c.setPlacementCtxFactoryForTesting(() => {
      factoryCalls++;
      return makeRecordingCtx();
    });

    const deferred = new DeferredPlacementCtx("/root");
    await c.flushPlacement!(k8sHandle(), { placement: deferred, sessionId: "s-test" });

    expect(factoryCalls).toBe(0);
  });
});

// ── KataCompute (inherits from K8sCompute) ──────────────────────────────────

describe("KataCompute.flushPlacement", () => {
  test("inherits K8s flushPlacement; uses k8s meta + factory unchanged", async () => {
    const c = new KataCompute(app);
    const ctx = makeRecordingCtx();
    const factoryArgs: Array<Record<string, unknown>> = [];
    c.setPlacementCtxFactoryForTesting((deps) => {
      factoryArgs.push(deps);
      return ctx;
    });

    const deferred = new DeferredPlacementCtx("/root");
    await deferred.writeFile("/root/.config/x", 0o600, new Uint8Array([1]));

    await c.flushPlacement!(kataHandle(), { placement: deferred, sessionId: "s-test" });

    expect(factoryArgs).toHaveLength(1);
    expect(factoryArgs[0]).toEqual({ namespace: "ark", podName: "ark-test-pod" });
    expect(ctx.writeCalls).toHaveLength(1);
  });
});

// ── FirecrackerCompute ──────────────────────────────────────────────────────

describe("FirecrackerCompute.flushPlacement", () => {
  test("constructs a FirecrackerPlacementCtx with vmId + guestIp from meta.firecracker", async () => {
    // FirecrackerCompute requires the availability gate to pass on
    // construction; stub it via deps so the test runs on macOS.
    const c = new FirecrackerCompute(app, {
      isFirecrackerAvailable: () => ({ ok: true }),
    });
    const ctx = makeRecordingCtx();
    const factoryArgs: Array<Record<string, unknown>> = [];
    c.setPlacementCtxFactoryForTesting((deps) => {
      factoryArgs.push(deps);
      return ctx;
    });

    const deferred = new DeferredPlacementCtx("/root");
    await deferred.writeFile("/root/.ssh/id_test", 0o600, new Uint8Array([9]));

    await c.flushPlacement!(fcHandle(), { placement: deferred, sessionId: "s-test" });

    expect(factoryArgs).toHaveLength(1);
    expect(factoryArgs[0]).toEqual({ vmId: "ark-fc-test", guestIp: "172.17.0.2" });
    expect(ctx.writeCalls).toHaveLength(1);
  });

  test("no-op on empty queue", async () => {
    const c = new FirecrackerCompute(app, {
      isFirecrackerAvailable: () => ({ ok: true }),
    });
    let factoryCalls = 0;
    c.setPlacementCtxFactoryForTesting(() => {
      factoryCalls++;
      return makeRecordingCtx();
    });

    const deferred = new DeferredPlacementCtx("/root");
    await c.flushPlacement!(fcHandle(), { placement: deferred, sessionId: "s-test" });

    expect(factoryCalls).toBe(0);
  });
});
