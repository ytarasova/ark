/**
 * ComputeTarget delegation tests.
 *
 * Uses fake Compute + Runtime impls so we can prove every ComputeTarget
 * method calls the right underlying method once, in the expected order,
 * with the expected arguments -- and that errors on either side propagate.
 */

import { describe, it, expect } from "bun:test";

import { ComputeTarget } from "../compute-target.js";
import type {
  AgentHandle,
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  LaunchOpts,
  PrepareCtx,
  ProvisionOpts,
  Runtime,
  Snapshot,
} from "../types.js";

type Call = { method: string; args: unknown[] };

class FakeCompute implements Compute {
  readonly kind = "local" as const;
  readonly capabilities: ComputeCapabilities = {
    snapshot: true,
    pool: false,
    networkIsolation: false,
    provisionLatency: "instant",
  };
  calls: Call[] = [];
  failOn: Set<string> = new Set();

  private handle: ComputeHandle = { kind: "local", name: "fake", meta: {} };

  private maybeThrow(method: string) {
    if (this.failOn.has(method)) throw new Error(`fake-compute-${method}-failed`);
  }

  async provision(opts: ProvisionOpts): Promise<ComputeHandle> {
    this.calls.push({ method: "provision", args: [opts] });
    this.maybeThrow("provision");
    return this.handle;
  }
  async start(h: ComputeHandle): Promise<void> {
    this.calls.push({ method: "start", args: [h] });
    this.maybeThrow("start");
  }
  async stop(h: ComputeHandle): Promise<void> {
    this.calls.push({ method: "stop", args: [h] });
    this.maybeThrow("stop");
  }
  async destroy(h: ComputeHandle): Promise<void> {
    this.calls.push({ method: "destroy", args: [h] });
    this.maybeThrow("destroy");
  }
  getArkdUrl(h: ComputeHandle): string {
    this.calls.push({ method: "getArkdUrl", args: [h] });
    return "http://fake-compute:1234";
  }
  async snapshot(h: ComputeHandle): Promise<Snapshot> {
    this.calls.push({ method: "snapshot", args: [h] });
    this.maybeThrow("snapshot");
    return {
      id: "snap-1",
      computeKind: this.kind,
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: {},
    };
  }
  async restore(s: Snapshot): Promise<ComputeHandle> {
    this.calls.push({ method: "restore", args: [s] });
    this.maybeThrow("restore");
    return this.handle;
  }
  rehydrateHandle(state: { kind: ComputeHandle["kind"]; name: string; meta: Record<string, unknown> }) {
    return {
      kind: state.kind,
      name: state.name,
      meta: state.meta,
      async spawnProcess() {
        return { pid: 0 };
      },
      async killProcess() {
        return { wasRunning: false };
      },
      async statusProcess() {
        return { running: false };
      },
      async getMetrics() {
        return {
          cpu: { count: 1, loadAvg: 0, processes: 0 },
          memory: { totalMB: 0, usedMB: 0 },
          disk: { totalMB: 0, usedMB: 0 },
          uptimeSec: 0,
        } as never;
      },
    };
  }
}

class FakeRuntime implements Runtime {
  readonly kind = "direct" as const;
  readonly name = "fake-runtime";
  calls: Call[] = [];
  failOn: Set<string> = new Set();

  private maybeThrow(method: string) {
    if (this.failOn.has(method)) throw new Error(`fake-runtime-${method}-failed`);
  }

  async prepare(compute: Compute, h: ComputeHandle, ctx: PrepareCtx): Promise<void> {
    this.calls.push({ method: "prepare", args: [compute, h, ctx] });
    this.maybeThrow("prepare");
  }
  async launchAgent(compute: Compute, h: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle> {
    this.calls.push({ method: "launchAgent", args: [compute, h, opts] });
    this.maybeThrow("launchAgent");
    return { sessionName: opts.tmuxName };
  }
  async shutdown(compute: Compute, h: ComputeHandle): Promise<void> {
    this.calls.push({ method: "shutdown", args: [compute, h] });
    this.maybeThrow("shutdown");
  }
}

function sampleHandle(): ComputeHandle {
  return { kind: "local", name: "fake", meta: {} };
}

describe("ComputeTarget", async () => {
  describe("compute delegation", async () => {
    it("provision / start / stop / destroy delegate to Compute", async () => {
      const compute = new FakeCompute();
      const runtime = new FakeRuntime();
      const target = new ComputeTarget(compute, runtime);

      const h = await target.provision({ tags: { name: "fake" } });
      await target.start(h);
      await target.stop(h);
      await target.destroy(h);

      expect(compute.calls.map((c) => c.method)).toEqual(["provision", "start", "stop", "destroy"]);
      expect(runtime.calls.length).toBe(0);
    });

    it("getArkdUrl delegates to Compute", () => {
      const compute = new FakeCompute();
      const target = new ComputeTarget(compute, new FakeRuntime());
      expect(target.getArkdUrl(sampleHandle())).toBe("http://fake-compute:1234");
      expect(compute.calls.map((c) => c.method)).toEqual(["getArkdUrl"]);
    });

    it("snapshot / restore delegate to Compute", async () => {
      const compute = new FakeCompute();
      const target = new ComputeTarget(compute, new FakeRuntime());
      const snap = await target.snapshot(sampleHandle());
      const restored = await target.restore(snap);
      expect(compute.calls.map((c) => c.method)).toEqual(["snapshot", "restore"]);
      expect(restored.name).toBe("fake");
    });

    it("propagates errors from the Compute side", async () => {
      const compute = new FakeCompute();
      compute.failOn.add("provision");
      const target = new ComputeTarget(compute, new FakeRuntime());
      (await expect(target.provision({}))).rejects.toThrow("fake-compute-provision-failed");
    });
  });

  describe("runtime delegation", async () => {
    it("prepare / launchAgent / shutdown delegate to Runtime with the Compute forwarded", async () => {
      const compute = new FakeCompute();
      const runtime = new FakeRuntime();
      const target = new ComputeTarget(compute, runtime);
      const h = sampleHandle();

      await target.prepare(h, { workdir: "/tmp" });
      const agent = await target.launchAgent(h, {
        tmuxName: "ark-s-x",
        workdir: "/tmp",
        launcherContent: "#!/bin/bash\n:",
      });
      await target.shutdown(h);

      expect(agent.sessionName).toBe("ark-s-x");
      expect(runtime.calls.map((c) => c.method)).toEqual(["prepare", "launchAgent", "shutdown"]);
      // Every runtime call receives the Compute as arg[0].
      for (const call of runtime.calls) expect(call.args[0]).toBe(compute);
      // Compute wasn't touched.
      expect(compute.calls.length).toBe(0);
    });

    it("propagates errors from the Runtime side", async () => {
      const runtime = new FakeRuntime();
      runtime.failOn.add("launchAgent");
      const target = new ComputeTarget(new FakeCompute(), runtime);
      (
        await expect(
          target.launchAgent(sampleHandle(), {
            tmuxName: "x",
            workdir: "/tmp",
            launcherContent: "#!/bin/bash\n:",
          }),
        )
      ).rejects.toThrow("fake-runtime-launchAgent-failed");
    });
  });
});
