/**
 * FirecrackerCompute unit tests.
 *
 * We exercise the Compute-level lifecycle (provision / start / stop /
 * destroy / getArkdUrl / snapshot / restore, plus the availability gate)
 * with every external dependency stubbed through `FirecrackerComputeDeps`:
 *
 *   - isFirecrackerAvailable -> returns `ok: true` unless a test flips it.
 *   - ensureRootfs           -> returns synthetic paths (the real fetcher
 *                               talks to S3; we never touch the network).
 *   - ensureBridge / createTap / removeTap / assignGuestIp ->
 *                               record calls, pretend they succeeded.
 *   - createVm               -> returns a FakeVm that implements the
 *                               FirecrackerVm interface and records every
 *                               method call.
 *   - waitForArkdReady       -> resolves instantly by default; tests that
 *                               want to exercise the timeout path override.
 *
 * The FakeVm is intentionally dumb -- we assert lifecycle ordering via the
 * call log, not by trying to simulate Firecracker semantics. Real-VM
 * behavior is covered by the e2e test in `firecracker-compute-e2e.test.ts`
 * (skipped by default, gated on Linux + KVM + opt-in env var).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";

import { FirecrackerCompute, type FirecrackerMeta } from "../core/firecracker/compute.js";
import type { FirecrackerVm, FirecrackerVmSpec, SnapshotArtifacts, SnapshotOpts } from "../core/firecracker/vm.js";
import type { GuestAddr } from "../core/firecracker/network.js";
import type { AvailabilityResult } from "../core/firecracker/availability.js";
import type { RootfsPaths } from "../core/firecracker/rootfs.js";
import type { ComputeHandle, Snapshot } from "../core/types.js";
import { AppContext } from "../../core/app.js";
import { setApp, clearApp } from "../../core/__tests__/test-helpers.js";

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

// ── Fake VM ─────────────────────────────────────────────────────────────────

interface FakeVmCall {
  op: "start" | "stop" | "pause" | "resume" | "snapshot" | "restore" | "getGuestIp";
  payload?: unknown;
}

class FakeVm implements FirecrackerVm {
  readonly spec: FirecrackerVmSpec;
  readonly socketPath: string;
  readonly pid: number | null = 1234;
  readonly calls: FakeVmCall[] = [];
  /** When true, `start()` rejects. Used to test teardown on boot failure. */
  startShouldFail = false;
  /** Return value for snapshot(). Defaults to echoing the requested paths. */
  snapshotResult: SnapshotArtifacts | null = null;

  constructor(spec: FirecrackerVmSpec) {
    this.spec = spec;
    this.socketPath = `/fake/sock/${spec.id}.sock`;
  }

  async start(): Promise<void> {
    this.calls.push({ op: "start" });
    if (this.startShouldFail) throw new Error("fake boot failure");
  }
  async stop(): Promise<void> {
    this.calls.push({ op: "stop" });
  }
  async pause(): Promise<void> {
    this.calls.push({ op: "pause" });
  }
  async resume(): Promise<void> {
    this.calls.push({ op: "resume" });
  }
  async snapshot(opts: SnapshotOpts): Promise<SnapshotArtifacts> {
    this.calls.push({ op: "snapshot", payload: opts });
    return this.snapshotResult ?? { memFilePath: opts.memFilePath, stateFilePath: opts.stateFilePath };
  }
  async restore(from: SnapshotArtifacts): Promise<void> {
    this.calls.push({ op: "restore", payload: from });
  }
  async getGuestIp(): Promise<string | null> {
    this.calls.push({ op: "getGuestIp" });
    return null;
  }
}

// ── Test fixtures ───────────────────────────────────────────────────────────

interface CallLog {
  ensureRootfs: number;
  ensureBridge: string[];
  createTap: Array<{ name: string; bridge: string }>;
  removeTap: string[];
  assignGuestIp: string[];
  createVm: FirecrackerVmSpec[];
  waitForArkdReady: Array<{ url: string; timeoutMs: number }>;
  vms: FakeVm[];
}

function makeCompute(overrides: {
  availability?: AvailabilityResult;
  rootfs?: RootfsPaths;
  guestAddr?: GuestAddr;
  waitShouldFail?: boolean;
  startShouldFail?: boolean;
  snapshotResult?: SnapshotArtifacts;
}): { compute: FirecrackerCompute; log: CallLog } {
  const log: CallLog = {
    ensureRootfs: 0,
    ensureBridge: [],
    createTap: [],
    removeTap: [],
    assignGuestIp: [],
    createVm: [],
    waitForArkdReady: [],
    vms: [],
  };

  const compute = new FirecrackerCompute(app, {
    isFirecrackerAvailable: () => overrides.availability ?? { ok: true },
    ensureRootfs: async () => {
      log.ensureRootfs += 1;
      return overrides.rootfs ?? { kernelPath: "/fake/kernel", rootfsPath: "/fake/rootfs" };
    },
    ensureBridge: async (name) => {
      log.ensureBridge.push(name);
    },
    createTap: async (name, bridge) => {
      log.createTap.push({ name, bridge });
    },
    removeTap: async (name) => {
      log.removeTap.push(name);
    },
    assignGuestIp: async (name) => {
      log.assignGuestIp.push(name);
      return (
        overrides.guestAddr ?? {
          hostIp: "192.168.127.1",
          guestIp: "192.168.127.2",
          mask: "255.255.255.252",
          prefixLen: 30,
        }
      );
    },
    createVm: (spec) => {
      log.createVm.push(spec);
      const vm = new FakeVm(spec);
      vm.startShouldFail = !!overrides.startShouldFail;
      if (overrides.snapshotResult) vm.snapshotResult = overrides.snapshotResult;
      log.vms.push(vm);
      return vm;
    },
    waitForArkdReady: async (url, timeoutMs) => {
      log.waitForArkdReady.push({ url, timeoutMs });
      if (overrides.waitShouldFail) throw new Error("not ready");
    },
  });
  return { compute, log };
}

let compute: FirecrackerCompute;
let log: CallLog;

beforeEach(() => {
  ({ compute, log } = makeCompute({}));
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("FirecrackerCompute kind and capabilities", () => {
  it("reports kind=firecracker", () => {
    expect(compute.kind).toBe("firecracker");
  });
  it("capabilities declare snapshot + pool + network isolation", () => {
    expect(compute.capabilities).toEqual({
      snapshot: true,
      pool: true,
      networkIsolation: true,
      provisionLatency: "seconds",
    });
  });
});

describe("provision", async () => {
  it("short-circuits with an actionable error when Firecracker is unavailable", async () => {
    ({ compute, log } = makeCompute({
      availability: { ok: false, reason: "Firecracker requires Linux with KVM; detected darwin" },
    }));
    (await expect(compute.provision({ tags: { name: "vm1" } }))).rejects.toThrow(/Firecracker compute unavailable/i);
    // Nothing else should have been attempted on the gated path.
    expect(log.ensureRootfs).toBe(0);
    expect(log.ensureBridge).toEqual([]);
    expect(log.createVm).toEqual([]);
  });

  it("runs rootfs + network + VM setup in order, returns the firecracker meta shape", async () => {
    const h = await compute.provision({ tags: { name: "vm1" } });

    expect(log.ensureRootfs).toBe(1);
    expect(log.ensureBridge).toEqual(["fc0"]);
    expect(log.createTap).toHaveLength(1);
    expect(log.createTap[0].bridge).toBe("fc0");
    expect(log.assignGuestIp).toHaveLength(1);
    expect(log.createVm).toHaveLength(1);
    expect(log.createVm[0].kernelPath).toBe("/fake/kernel");
    expect(log.createVm[0].rootfsPath).toBe("/fake/rootfs");
    expect(log.createVm[0].bootArgs).toContain("ip=192.168.127.2::192.168.127.1:255.255.255.252::eth0:off");

    // FakeVm recorded a single start() call; arkd readiness polled once.
    expect(log.vms[0].calls.map((c) => c.op)).toEqual(["start"]);
    expect(log.waitForArkdReady).toHaveLength(1);
    expect(log.waitForArkdReady[0].url).toBe("http://192.168.127.2:19300");
    expect(log.waitForArkdReady[0].timeoutMs).toBe(60_000);

    // Handle shape.
    expect(h.kind).toBe("firecracker");
    expect(h.name).toBe("vm1");
    const meta = (h.meta as { firecracker: FirecrackerMeta }).firecracker;
    expect(meta).toMatchObject({
      vmId: "ark-fc-vm1",
      guestIp: "192.168.127.2",
      hostIp: "192.168.127.1",
      kernelPath: "/fake/kernel",
      rootfsPath: "/fake/rootfs",
      arkdUrl: "http://192.168.127.2:19300",
    });
    expect(meta.tapName.startsWith("fc-")).toBe(true);
    expect(meta.socketPath).toMatch(/ark-fc-vm1\.sock$/);
  });

  it("generates a random name when opts.tags.name is missing", async () => {
    const h = await compute.provision({});
    expect(h.name).toMatch(/^fc-[a-z0-9]+$/);
  });

  it("forwards onLog callback with a ready message", async () => {
    const messages: string[] = [];
    await compute.provision({ tags: { name: "vm1" }, onLog: (m) => messages.push(m) });
    expect(messages.some((m) => m.includes("VM ark-fc-vm1 ready"))).toBe(true);
  });

  it("cleans up the TAP when VM start fails", async () => {
    ({ compute, log } = makeCompute({ startShouldFail: true }));
    (await expect(compute.provision({ tags: { name: "vm1" } }))).rejects.toThrow(/fake boot failure/);
    expect(log.removeTap).toHaveLength(1);
    expect(log.waitForArkdReady).toEqual([]);
  });

  it("cleans up the TAP + VM when arkd readiness times out", async () => {
    ({ compute, log } = makeCompute({ waitShouldFail: true }));
    (await expect(compute.provision({ tags: { name: "vm1" } }))).rejects.toThrow(/arkd did not come ready/);
    expect(log.removeTap).toHaveLength(1);
    // vm.stop called once during cleanup.
    const stops = log.vms[0].calls.filter((c) => c.op === "stop");
    expect(stops).toHaveLength(1);
  });

  it("honours a size hint (2x4 -> 2 vcpu, 4 GiB)", async () => {
    await compute.provision({ tags: { name: "vm1" }, size: "2x4" });
    expect(log.createVm[0].vcpuCount).toBe(2);
    expect(log.createVm[0].memMib).toBe(4096);
  });

  it("defaults to 2 vcpu / 1024 MiB when no size hint is given", async () => {
    await compute.provision({ tags: { name: "vm1" } });
    expect(log.createVm[0].vcpuCount).toBe(2);
    expect(log.createVm[0].memMib).toBe(1024);
  });
});

describe("start / stop", async () => {
  it("stop() pauses the VM, start() resumes it", async () => {
    const h = await compute.provision({ tags: { name: "vm1" } });
    log.vms[0].calls.length = 0;

    await compute.stop(h);
    await compute.start(h);

    expect(log.vms[0].calls.map((c) => c.op)).toEqual(["pause", "resume"]);
  });

  it("start/stop are no-ops when the VM is not live (e.g. after restart)", async () => {
    // Synthesise a handle without going through provision(), so the internal
    // vms map is empty.
    const handle: ComputeHandle = {
      kind: "firecracker",
      name: "stale",
      meta: {
        firecracker: {
          vmId: "ark-fc-stale",
          socketPath: "/dev/null",
          guestIp: "192.168.127.2",
          hostIp: "192.168.127.1",
          tapName: "fc-ark-fc-sta",
          kernelPath: "/k",
          rootfsPath: "/r",
          arkdUrl: "http://192.168.127.2:19300",
        },
      },
    };

    await compute.start(handle); // should not throw
    await compute.stop(handle); // should not throw
    expect(log.vms).toEqual([]);
  });
});

describe("destroy", async () => {
  it("stops the VM and removes the TAP", async () => {
    const h = await compute.provision({ tags: { name: "vm1" } });
    log.vms[0].calls.length = 0;
    log.removeTap.length = 0;

    await compute.destroy(h);

    expect(log.vms[0].calls.map((c) => c.op)).toEqual(["stop"]);
    expect(log.removeTap).toHaveLength(1);
    expect(log.removeTap[0]).toBe((h.meta as { firecracker: FirecrackerMeta }).firecracker.tapName);
  });

  it("is a safe no-op for a handle whose VM is no longer tracked", async () => {
    const handle: ComputeHandle = {
      kind: "firecracker",
      name: "stale",
      meta: {
        firecracker: {
          vmId: "ark-fc-stale",
          socketPath: "/dev/null",
          guestIp: "192.168.127.2",
          hostIp: "192.168.127.1",
          tapName: "fc-stale",
          kernelPath: "/k",
          rootfsPath: "/r",
          arkdUrl: "http://x",
        },
      },
    };
    await compute.destroy(handle); // should not throw
    // removeTap still runs for its side effect (best-effort).
    expect(log.removeTap).toEqual(["fc-stale"]);
  });
});

describe("getArkdUrl", async () => {
  it("returns handle.meta.firecracker.arkdUrl", async () => {
    const h = await compute.provision({ tags: { name: "vm1" } });
    expect(compute.getArkdUrl(h)).toBe("http://192.168.127.2:19300");
  });

  it("throws when the meta slot is missing", () => {
    const handle: ComputeHandle = { kind: "firecracker", name: "x", meta: {} };
    expect(() => compute.getArkdUrl(handle)).toThrow(/meta\.firecracker missing/);
  });
});

describe("snapshot / restore", async () => {
  it("snapshot() delegates to the VM manager and returns metadata with artifact paths", async () => {
    const h = await compute.provision({ tags: { name: "vm1" } });
    const snap = await compute.snapshot(h);

    expect(snap.computeKind).toBe("firecracker");
    expect(snap.id).toMatch(/^fc-ark-fc-vm1-\d+$/);
    expect(typeof snap.createdAt).toBe("string");

    const meta = snap.metadata as { vmId: string; tapName: string; artifacts: SnapshotArtifacts };
    expect(meta.vmId).toBe("ark-fc-vm1");
    expect(meta.artifacts.memFilePath).toMatch(/snapshot\/mem$/);
    expect(meta.artifacts.stateFilePath).toMatch(/snapshot\/state$/);

    // FakeVm recorded the snapshot call with the path we passed in.
    const snapCall = log.vms[0].calls.find((c) => c.op === "snapshot");
    expect(snapCall).toBeDefined();
  });

  it("snapshot() throws with a useful error when the VM isn't live", async () => {
    const handle: ComputeHandle = {
      kind: "firecracker",
      name: "stale",
      meta: {
        firecracker: {
          vmId: "ark-fc-stale",
          socketPath: "/dev/null",
          guestIp: "x",
          hostIp: "x",
          tapName: "t",
          kernelPath: "/k",
          rootfsPath: "/r",
          arkdUrl: "http://x",
        },
      },
    };
    (await expect(compute.snapshot(handle))).rejects.toThrow(/VM not live for snapshot/);
  });

  it("restore() rehydrates the VM and returns a fresh handle", async () => {
    const h = await compute.provision({ tags: { name: "vm1" } });
    const snap = await compute.snapshot(h);

    // Drop the in-memory VM handle so restore has to construct a new one.
    (compute as unknown as { vms: Map<string, unknown> }).vms.clear();
    log.createVm.length = 0;
    log.waitForArkdReady.length = 0;

    const restored = await compute.restore(snap);
    expect(restored.kind).toBe("firecracker");
    expect(restored.name).toBe("vm1");

    // A fresh VM was constructed with the same id; the VM manager's restore
    // was invoked, not start.
    expect(log.createVm).toHaveLength(1);
    expect(log.createVm[0].id).toBe("ark-fc-vm1");
    expect(log.vms.at(-1)!.calls.some((c) => c.op === "restore")).toBe(true);
    // Readiness re-probed after restore.
    expect(log.waitForArkdReady).toHaveLength(1);
  });

  it("restore() rejects snapshots taken on a different compute kind", async () => {
    const badSnapshot: Snapshot = {
      id: "not-fc",
      computeKind: "ec2",
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: {},
    };
    (await expect(compute.restore(badSnapshot))).rejects.toThrow(/Snapshot is for ec2/);
  });

  it("restore() rejects a snapshot with missing metadata fields", async () => {
    const incomplete: Snapshot = {
      id: "incomplete",
      computeKind: "firecracker",
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: { vmId: "x" /* missing tapName, kernelPath, rootfsPath, artifacts */ },
    };
    (await expect(compute.restore(incomplete))).rejects.toThrow(/missing required fields/);
  });
});
