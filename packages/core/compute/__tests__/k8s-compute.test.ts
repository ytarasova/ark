/**
 * K8sCompute unit tests.
 *
 * The k8s SDK (`@kubernetes/client-node`) and `kubectl` subprocess are both
 * heavy external dependencies. We stub both through `K8sCompute.setDeps`:
 *
 *   - `loadK8sModule` returns a fake module whose `KubeConfig` and
 *     `CoreV1Api` record every call into a shared `calls` array.
 *   - `spawnPortForward` returns a fake `ChildProcess` with a deterministic
 *     PID.
 *   - `allocatePort` returns a stable port so meta is easy to assert.
 *
 * The test target is the mapping "ProvisionOpts -> sequence of SDK calls +
 * handle.meta.k8s shape", plus the capability flags and the NotSupportedError
 * surface for snapshot / restore. The `k8s-kata-compute.test.ts` companion
 * file covers KataCompute's additional runtimeClassName annotation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { K8sCompute, type K8sComputeDeps } from "../k8s.js";
import { NotSupportedError, type ComputeHandle, type Snapshot } from "../types.js";
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

// ── Test doubles ───────────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  args: unknown[];
}

class FakeChildProcess extends EventEmitter {
  public pid: number;
  public killed = false;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

interface Harness {
  calls: RecordedCall[];
  spawnedArgs: string[][];
  nextPid: number;
  nextPort: number;
  missingNamespace: boolean;
  deps: K8sComputeDeps;
  lastPod: Record<string, any> | null;
  /** Default response for `fetchHealth`. Tests override per-test. */
  healthy: boolean;
  /** Recorded kill calls -- (pid). */
  killCalls: number[];
  /**
   * `isPidAlive` override result. Defaults to true so the reuse-path's
   * second gate (the /health probe) is the one that decides the test.
   */
  pidAlive: boolean;
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  const harness: Harness = {
    calls: [],
    spawnedArgs: [],
    nextPid: 4242,
    nextPort: 35789,
    missingNamespace: false,
    lastPod: null,
    healthy: true,
    killCalls: [],
    pidAlive: true,
    deps: undefined as unknown as K8sComputeDeps,
    ...overrides,
  };

  const fakeModule = {
    KubeConfig: class {
      loadFromFile(path: string) {
        harness.calls.push({ method: "KubeConfig.loadFromFile", args: [path] });
      }
      loadFromDefault() {
        harness.calls.push({ method: "KubeConfig.loadFromDefault", args: [] });
      }
      makeApiClient(_ctor: unknown) {
        return {
          readNamespace: async (opts: { name: string }) => {
            harness.calls.push({ method: "readNamespace", args: [opts] });
            if (harness.missingNamespace) throw new Error("not found");
            return { metadata: { name: opts.name } };
          },
          createNamespace: async (opts: { body: unknown }) => {
            harness.calls.push({ method: "createNamespace", args: [opts] });
          },
          createNamespacedPod: async (opts: { namespace: string; body: any }) => {
            harness.calls.push({ method: "createNamespacedPod", args: [opts] });
            harness.lastPod = opts.body;
          },
          deleteNamespacedPod: async (opts: { name: string; namespace: string }) => {
            harness.calls.push({ method: "deleteNamespacedPod", args: [opts] });
          },
        };
      }
    },
    CoreV1Api: class {},
  };

  harness.deps = {
    loadK8sModule: async () => fakeModule as any,
    spawnPortForward: (args: string[]): ChildProcess => {
      harness.spawnedArgs.push(args);
      return new FakeChildProcess(harness.nextPid) as unknown as ChildProcess;
    },
    allocatePort: async () => harness.nextPort,
    fetchHealth: async () => harness.healthy,
    isPidAlive: () => harness.pidAlive,
    killProcess: (pid: number) => {
      harness.killCalls.push(pid);
    },
  };

  return harness;
}

function makeK8sCompute(deps: K8sComputeDeps): K8sCompute {
  const c = new K8sCompute(app);
  c.setDeps(deps);
  return c;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("K8sCompute", async () => {
  it("advertises the documented capability flags", () => {
    const c = new K8sCompute(app);
    expect(c.kind).toBe("k8s");
    expect(c.capabilities).toEqual({
      snapshot: false,
      pool: true,
      networkIsolation: false,
      provisionLatency: "seconds",
    });
  });

  describe("provision", async () => {
    let harness: Harness;
    let c: K8sCompute;

    beforeEach(() => {
      harness = makeHarness();
      c = makeK8sCompute(harness.deps);
    });

    it("creates a pod and records handle.meta.k8s", async () => {
      const h = await c.provision({
        tags: { name: "worker-1" },
        config: { namespace: "agents", image: "ghcr.io/ark/arkd:latest" },
      });

      expect(h.kind).toBe("k8s");
      expect(h.name).toBe("worker-1");
      const meta = (h.meta as any).k8s;
      expect(meta.podName).toBe("ark-worker-1");
      expect(meta.namespace).toBe("agents");
      expect(meta.portForwardPid).toBe(harness.nextPid);
      expect(meta.arkdLocalPort).toBe(harness.nextPort);
      expect(meta.runtimeClassName).toBeUndefined();
    });

    it("loads the default kubeconfig when no path is given", async () => {
      await c.provision({ tags: { name: "w" }, config: {} });
      const kinds = harness.calls.map((c) => c.method);
      expect(kinds).toContain("KubeConfig.loadFromDefault");
    });

    it("loads the explicit kubeconfig when one is given", async () => {
      await c.provision({ tags: { name: "w" }, config: { kubeconfig: "/tmp/kc.yaml" } });
      const loads = harness.calls.filter((c) => c.method === "KubeConfig.loadFromFile");
      expect(loads).toHaveLength(1);
      expect(loads[0].args[0] as string).toBe("/tmp/kc.yaml");
    });

    it("creates the namespace if readNamespace fails", async () => {
      harness.missingNamespace = true;
      await c.provision({ tags: { name: "w" }, config: { namespace: "new-ns" } });
      const kinds = harness.calls.map((c) => c.method);
      expect(kinds).toContain("createNamespace");
    });

    it("spawns `kubectl port-forward` with the expected args", async () => {
      const h = await c.provision({
        tags: { name: "w" },
        config: { namespace: "ns1", kubeconfig: "/tmp/kc.yaml" },
      });
      expect(harness.spawnedArgs).toHaveLength(1);
      const args = harness.spawnedArgs[0];
      expect(args).toEqual([
        "--kubeconfig",
        "/tmp/kc.yaml",
        "port-forward",
        "-n",
        "ns1",
        `pod/${(h.meta as any).k8s.podName}`,
        `${harness.nextPort}:19300`,
      ]);
    });

    it("does NOT set runtimeClassName on the pod spec (vanilla k8s)", async () => {
      await c.provision({ tags: { name: "w" }, config: {} });
      expect(harness.lastPod).toBeTruthy();
      expect(harness.lastPod!.spec.runtimeClassName).toBeUndefined();
    });

    it("declares the arkd container port on the pod spec", async () => {
      await c.provision({ tags: { name: "w" }, config: {} });
      const containers = harness.lastPod!.spec.containers;
      expect(containers).toHaveLength(1);
      expect(containers[0].ports).toEqual([{ containerPort: 19300, name: "arkd" }]);
    });

    it("defaults namespace to 'ark' and image to 'ubuntu:22.04'", async () => {
      await c.provision({ tags: { name: "w" }, config: {} });
      expect(harness.lastPod!.metadata.namespace).toBe("ark");
      expect(harness.lastPod!.spec.containers[0].image).toBe("ubuntu:22.04");
    });
  });

  describe("getArkdUrl", async () => {
    it("points at the local port-forward endpoint", async () => {
      const harness = makeHarness({ nextPort: 50001 });
      const c = makeK8sCompute(harness.deps);
      const h = await c.provision({ tags: { name: "w" }, config: {} });
      expect(c.getArkdUrl(h)).toBe("http://localhost:50001");
    });

    it("throws a clear error if handle.meta.k8s is missing", () => {
      const harness = makeHarness();
      const c = makeK8sCompute(harness.deps);
      const bad: ComputeHandle = { kind: "k8s", name: "oops", meta: {} };
      expect(() => c.getArkdUrl(bad)).toThrow(/handle\.meta\.k8s is missing/);
    });
  });

  describe("start / stop", async () => {
    it("stop kills the port-forward subprocess and clears the pid", async () => {
      const harness = makeHarness();
      const c = makeK8sCompute(harness.deps);
      const h = await c.provision({ tags: { name: "w" }, config: {} });
      expect((h.meta as any).k8s.portForwardPid).toBeTruthy();

      // Override `process.kill` to observe the signal without actually
      // killing a PID. Using Bun's global `process` is safe -- we restore
      // after the call.
      const originalKill = process.kill;
      const killed: Array<{ pid: number; sig: string | number | undefined }> = [];
      (process as any).kill = (pid: number, sig?: string | number) => {
        killed.push({ pid, sig });
      };
      try {
        await c.stop(h);
      } finally {
        (process as any).kill = originalKill;
      }

      expect(killed).toHaveLength(1);
      expect(killed[0].sig).toBe("SIGTERM");
      expect((h.meta as any).k8s.portForwardPid).toBeNull();
    });

    it("start re-spawns the port-forward when stopped", async () => {
      const harness = makeHarness();
      const c = makeK8sCompute(harness.deps);
      const h = await c.provision({ tags: { name: "w" }, config: {} });

      const originalKill = process.kill;
      (process as any).kill = () => {};
      try {
        await c.stop(h);
      } finally {
        (process as any).kill = originalKill;
      }
      expect((h.meta as any).k8s.portForwardPid).toBeNull();

      // Next spawn returns a different PID to prove re-spawn actually ran.
      harness.nextPid = 5555;
      await c.start(h);
      expect((h.meta as any).k8s.portForwardPid).toBe(5555);
      expect(harness.spawnedArgs).toHaveLength(2);
    });

    it("start is a no-op if the port-forward is already running", async () => {
      const harness = makeHarness();
      const c = makeK8sCompute(harness.deps);
      const h = await c.provision({ tags: { name: "w" }, config: {} });
      await c.start(h);
      // Still just the one spawn from provision.
      expect(harness.spawnedArgs).toHaveLength(1);
    });
  });

  describe("destroy", async () => {
    it("deletes the pod and tears down the port-forward", async () => {
      const harness = makeHarness();
      const c = makeK8sCompute(harness.deps);
      const h = await c.provision({ tags: { name: "w" }, config: { namespace: "ns" } });

      const originalKill = process.kill;
      (process as any).kill = () => {};
      try {
        await c.destroy(h);
      } finally {
        (process as any).kill = originalKill;
      }

      const deletes = harness.calls.filter((c) => c.method === "deleteNamespacedPod");
      expect(deletes).toHaveLength(1);
      expect(deletes[0].args[0]).toMatchObject({
        name: (h.meta as any).k8s.podName,
        namespace: "ns",
      });
    });
  });

  describe("ensureReachable", async () => {
    // Idempotency tests for the dispatch-time reuse logic. The reuse-path
    // checks BOTH `isPidAlive` AND `fetchHealth(/health)`; failing either
    // gate must trigger a kill+respawn.

    it("second call with healthy reused tunnel does not spawn again", async () => {
      const harness = makeHarness();
      const c = makeK8sCompute(harness.deps);

      // First, provision so we have a recorded PID + port. The provision
      // path itself spawns once (fresh meta has no recorded PID).
      const h = await c.provision({ tags: { name: "w" }, config: {} });
      expect(harness.spawnedArgs).toHaveLength(1);

      // Now call ensureReachable twice. Both gates pass (pidAlive=true,
      // healthy=true) so neither call should respawn.
      await c.ensureReachable!(h, { app, sessionId: "s-1" });
      await c.ensureReachable!(h, { app, sessionId: "s-1" });

      expect(harness.spawnedArgs).toHaveLength(1);
      expect(harness.killCalls).toEqual([]);
    });

    it("second call with stale PID kills orphan and respawns", async () => {
      // PID alive, but /health probe returns false -- the most realistic
      // failure mode (kubectl up but the pod is evicted / not forwarding).
      // The reuse-path should kill and respawn.
      const harness = makeHarness({ healthy: false });
      const c = makeK8sCompute(harness.deps);

      const h = await c.provision({ tags: { name: "w" }, config: {} });
      expect(harness.spawnedArgs).toHaveLength(1);
      const originalPid = (h.meta as any).k8s.portForwardPid;

      // Give the next spawn a different PID so the meta swap is observable.
      harness.nextPid = 5555;
      harness.nextPort = 60002;

      await c.ensureReachable!(h, { app, sessionId: "s-1" });

      // The orphan kubectl PID must have been killed.
      expect(harness.killCalls).toEqual([originalPid]);
      // A fresh `kubectl port-forward` was spawned.
      expect(harness.spawnedArgs).toHaveLength(2);
      // Meta now points at the freshly spawned PID + port.
      expect((h.meta as any).k8s.portForwardPid).toBe(5555);
      expect((h.meta as any).k8s.arkdLocalPort).toBe(60002);
    });

    it("second call with dead PID respawns without trying to kill", async () => {
      // PID NOT alive -- the orphan is already gone, so no kill is needed
      // (and calling kill on a dead PID would just record a wasted ESRCH).
      const harness = makeHarness({ pidAlive: false });
      const c = makeK8sCompute(harness.deps);

      const h = await c.provision({ tags: { name: "w" }, config: {} });
      expect(harness.spawnedArgs).toHaveLength(1);

      harness.nextPid = 7777;
      await c.ensureReachable!(h, { app, sessionId: "s-1" });

      // Dead PID -- no kill expected.
      expect(harness.killCalls).toEqual([]);
      // But a fresh spawn is still required.
      expect(harness.spawnedArgs).toHaveLength(2);
      expect((h.meta as any).k8s.portForwardPid).toBe(7777);
    });
  });

  describe("snapshot / restore", async () => {
    it("snapshot throws NotSupportedError", async () => {
      const harness = makeHarness();
      const c = makeK8sCompute(harness.deps);
      const h = await c.provision({ tags: { name: "w" }, config: {} });
      (await expect(c.snapshot(h))).rejects.toBeInstanceOf(NotSupportedError);
    });

    it("restore throws NotSupportedError", async () => {
      const harness = makeHarness();
      const c = makeK8sCompute(harness.deps);
      const snap: Snapshot = {
        id: "x",
        computeKind: "k8s",
        createdAt: new Date().toISOString(),
        sizeBytes: 0,
        metadata: {},
      };
      (await expect(c.restore(snap))).rejects.toBeInstanceOf(NotSupportedError);
    });
  });
});
