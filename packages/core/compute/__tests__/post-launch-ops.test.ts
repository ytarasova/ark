/**
 * Post-launch ops on AgentHandle and ComputeHandle.
 *
 * Validates that the new two-axis world covers the full session lifecycle
 * (launch + kill + captureOutput + checkAlive + getMetrics) without falling
 * back to the legacy ComputeProvider registry. After Task 4 deletes the
 * legacy registry, these operations only exist on the new interfaces.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import type { ArkdClient } from "../../../arkd/client/index.js";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { LocalCompute } from "../core/local.js";
import { DirectIsolation } from "../isolation/direct.js";

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

/**
 * Stub ArkdClient that records every call and returns canned responses.
 * Drives the asserts below without touching the real arkd HTTP server.
 */
type CallRecord = { method: string; payload: any };

function makeStubClient(
  record: CallRecord[],
  opts?: { running?: boolean; output?: string; metrics?: any },
): ArkdClient {
  return {
    launchAgent: async (req: any) => {
      record.push({ method: "launchAgent", payload: req });
      return { ok: true } as any;
    },
    killAgent: async (req: any) => {
      record.push({ method: "killAgent", payload: req });
      return { ok: true } as any;
    },
    captureOutput: async (req: any) => {
      record.push({ method: "captureOutput", payload: req });
      return { output: opts?.output ?? "" } as any;
    },
    agentStatus: async (req: any) => {
      record.push({ method: "agentStatus", payload: req });
      return { running: opts?.running ?? false } as any;
    },
    snapshot: async () => {
      record.push({ method: "snapshot", payload: null });
      return (
        opts?.metrics ?? {
          metrics: {
            cpu: 1.5,
            memTotalGb: 16,
            memUsedGb: 4,
            memPct: 25,
            diskPct: 50,
            netRxMb: 0,
            netTxMb: 0,
            uptime: "1d",
            idleTicks: 0,
          },
          sessions: [],
          processes: [],
          docker: [],
        }
      );
    },
  } as unknown as ArkdClient;
}

describe("AgentHandle post-launch ops on local + direct target", () => {
  it("AgentHandle exposes kill, captureOutput, and checkAlive bound to arkd", async () => {
    const calls: CallRecord[] = [];
    const compute = new LocalCompute(app);
    compute.setClientFactoryForTesting(() => makeStubClient(calls, { running: true, output: "hello pane" }));

    const isolation = new DirectIsolation(app);
    isolation.setClientFactory(() => makeStubClient(calls, { running: true, output: "hello pane" }));

    const handle = await compute.provision({ tags: { name: "local" } });
    await isolation.prepare(compute, handle, { workdir: "/tmp" });
    const sessionName = `ark-test-${Date.now()}`;
    const agent = await isolation.launchAgent(compute, handle, {
      tmuxName: sessionName,
      workdir: "/tmp",
      launcherContent: "#!/bin/sh\nsleep 30\n",
    });

    expect(typeof agent.kill).toBe("function");
    expect(typeof agent.captureOutput).toBe("function");
    expect(typeof agent.checkAlive).toBe("function");
    expect(agent.sessionName).toBe(sessionName);

    // captureOutput round-trips arkd's output field.
    const out = await agent.captureOutput();
    expect(out).toBe("hello pane");

    // checkAlive returns true when arkd reports running.
    const aliveTrue = await agent.checkAlive();
    expect(aliveTrue).toBe(true);

    // kill calls arkd's killAgent endpoint with the session name.
    await agent.kill();
    const killCall = calls.find((c) => c.method === "killAgent");
    expect(killCall).toBeDefined();
    expect(killCall!.payload).toEqual({ sessionName });
  });

  it("checkAlive returns false when arkd reports not running", async () => {
    const calls: CallRecord[] = [];
    const compute = new LocalCompute(app);
    compute.setClientFactoryForTesting(() => makeStubClient(calls, { running: false }));
    const isolation = new DirectIsolation(app);
    isolation.setClientFactory(() => makeStubClient(calls, { running: false }));

    const handle = await compute.provision({});
    const agent = await isolation.launchAgent(compute, handle, {
      tmuxName: "ark-test-dead",
      workdir: "/tmp",
      launcherContent: "#!/bin/sh\nexit 0",
    });

    const alive = await agent.checkAlive();
    expect(alive).toBe(false);
  });

  it("checkAlive returns false when arkd is unreachable", async () => {
    const compute = new LocalCompute(app);
    compute.setClientFactoryForTesting(
      () =>
        ({
          agentStatus: async () => {
            throw new Error("arkd unreachable");
          },
        }) as unknown as ArkdClient,
    );
    const isolation = new DirectIsolation(app);
    isolation.setClientFactory(
      () =>
        ({
          launchAgent: async () => ({ ok: true }),
          agentStatus: async () => {
            throw new Error("arkd unreachable");
          },
        }) as unknown as ArkdClient,
    );

    const handle = await compute.provision({});
    const agent = await isolation.launchAgent(compute, handle, {
      tmuxName: "ark-test-unreachable",
      workdir: "/tmp",
      launcherContent: "",
    });

    const alive = await agent.checkAlive();
    expect(alive).toBe(false);
  });

  it("Isolation.attachAgent rebuilds an AgentHandle without re-launching", async () => {
    const calls: CallRecord[] = [];
    const compute = new LocalCompute(app);
    compute.setClientFactoryForTesting(() => makeStubClient(calls, { running: true }));
    const isolation = new DirectIsolation(app);
    isolation.setClientFactory(() => makeStubClient(calls, { running: true }));

    const handle = await compute.provision({});
    const rehydrated = isolation.attachAgent(compute, handle, "ark-rehydrated");

    expect(rehydrated.sessionName).toBe("ark-rehydrated");
    expect(typeof rehydrated.kill).toBe("function");
    // No launchAgent call -- attach is pure.
    expect(calls.find((c) => c.method === "launchAgent")).toBeUndefined();

    await rehydrated.kill();
    const killCall = calls.find((c) => c.method === "killAgent");
    expect(killCall).toBeDefined();
    expect(killCall!.payload).toEqual({ sessionName: "ark-rehydrated" });
  });
});

describe("ComputeHandle.getMetrics on local target", () => {
  it("returns the ComputeSnapshot shape from arkd /snapshot", async () => {
    const calls: CallRecord[] = [];
    const compute = new LocalCompute(app);
    compute.setClientFactoryForTesting(() => makeStubClient(calls));

    const handle = await compute.provision({ tags: { name: "local" } });
    expect(typeof handle.getMetrics).toBe("function");

    const snapshot = await handle.getMetrics!();

    expect(snapshot).toHaveProperty("metrics");
    expect(snapshot).toHaveProperty("sessions");
    expect(snapshot).toHaveProperty("processes");
    expect(snapshot).toHaveProperty("docker");
    expect(snapshot.metrics).toHaveProperty("cpu");
    expect(snapshot.metrics).toHaveProperty("memTotalGb");

    const snapCall = calls.find((c) => c.method === "snapshot");
    expect(snapCall).toBeDefined();
  });

  it("attachExistingHandle returns a handle with getMetrics wired", async () => {
    const calls: CallRecord[] = [];
    const compute = new LocalCompute(app);
    compute.setClientFactoryForTesting(() => makeStubClient(calls));

    const handle = compute.attachExistingHandle({ name: "local", status: "running", config: {} });
    expect(handle).not.toBeNull();
    expect(typeof handle!.getMetrics).toBe("function");

    const snapshot = await handle!.getMetrics!();
    expect(snapshot.metrics).toBeDefined();
  });
});
