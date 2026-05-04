/**
 * EC2Compute unit tests.
 *
 * The whole AWS + SSM surface is faked via `setHelpersForTesting` so no
 * network / subprocess is touched. Each test records the sequence of helper
 * calls so we can assert both behaviour and lifecycle order.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { EC2Compute, type EC2ComputeHelpers, type EC2HandleMeta, ARKD_REMOTE_PORT } from "../core/ec2.js";
import { NotSupportedError, type ComputeHandle, type Snapshot } from "../core/types.js";
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

// ── Test doubles ─────────────────────────────────────────────────────────────

type Call = { fn: string; args: unknown[] };

interface StubOpts {
  /** If set, provisionStack returns this IP. Default "1.2.3.4". */
  ip?: string | null;
  /** If false, the cloud-init readiness probe never sees "ready". */
  readyMarker?: boolean;
  /** If true, fetchHealth always returns true. */
  healthy?: boolean;
  /** Pre-allocated port the stub will hand out. */
  localPort?: number;
  /** Override spawned port-forward PID. */
  tunnelPid?: number;
  /** startInstance response. */
  startIp?: { publicIp: string | null; privateIp: string | null };
  /** Force provisionStack to throw. */
  provisionError?: Error;
  /** If false, ssmCheckInstance returns false. */
  ssmOnline?: boolean;
}

function makeHelpers(opts: StubOpts = {}): { helpers: EC2ComputeHelpers; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ fn: name, args });
    };

  // `opts.ip === null` is a meaningful signal (provisionStack returned no IP),
  // so distinguish it from "not set" rather than using `??`.
  const ip: string | null = "ip" in opts ? (opts.ip ?? null) : "1.2.3.4";
  const localPort = opts.localPort ?? 54321;
  const tunnelPid = opts.tunnelPid ?? 99999;

  const helpers: EC2ComputeHelpers = {
    ssmExec: async (execOpts) => {
      record("ssmExec")(execOpts);
      // Ready-marker probe -- return "ready" if readyMarker is truthy (default).
      if (execOpts.command.includes(".ark-ready")) {
        return { stdout: opts.readyMarker === false ? "" : "ready\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "ok\n", stderr: "", exitCode: 0 };
    },
    ssmCheckInstance: async (checkOpts) => {
      record("ssmCheckInstance")(checkOpts);
      return opts.ssmOnline !== false;
    },
    ssmWaitForReady: async (waitOpts) => {
      record("ssmWaitForReady")(waitOpts);
      return opts.ssmOnline !== false;
    },
    buildUserData: async (o) => {
      record("buildUserData")(o);
      return "#cloud-config\n# fake\n";
    },
    provisionStack: async (hostName, stackOpts) => {
      record("provisionStack")(hostName, stackOpts);
      if (opts.provisionError) throw opts.provisionError;
      return {
        ip,
        instance_id: "i-abc123",
        stack_name: `ark-compute-${hostName}`,
        sg_id: "sg-0001",
      };
    },
    destroyStack: async (hostName, destroyOpts) => {
      record("destroyStack")(hostName, destroyOpts);
    },
    startInstance: async (startOpts) => {
      record("startInstance")(startOpts);
      return opts.startIp ?? { publicIp: ip, privateIp: "10.0.0.5" };
    },
    stopInstance: async (stopOpts) => {
      record("stopInstance")(stopOpts);
    },
    describeInstance: async (descOpts) => {
      record("describeInstance")(descOpts);
      return { publicIp: ip, privateIp: "10.0.0.5" };
    },
    startPortForward: (tunnelOpts) => {
      record("startPortForward")(tunnelOpts);
      return { pid: tunnelPid };
    },
    killPortForward: (pid) => {
      record("killPortForward")(pid);
    },
    allocatePort: async () => {
      record("allocatePort")();
      return localPort;
    },
    fetchHealth: async (url, timeoutMs) => {
      record("fetchHealth")(url, timeoutMs);
      return opts.healthy !== false;
    },
    poll: async (check) => {
      record("poll")();
      // Run the check a few times to exercise it; any true wins.
      for (let i = 0; i < 3; i++) {
        if (await check()) return true;
      }
      return false;
    },
  };
  return { helpers, calls };
}

function makeProvisionedHandle(meta: Partial<EC2HandleMeta> = {}): ComputeHandle {
  const full: EC2HandleMeta = {
    instanceId: "i-abc123",
    publicIp: "1.2.3.4",
    privateIp: "10.0.0.5",
    arkdLocalPort: 54321,
    portForwardPid: 99999,
    region: "us-east-1",
    stackName: "ark-compute-test",
    sgId: "sg-0001",
    size: "m",
    arch: "x64",
    ...meta,
  };
  return { kind: "ec2", name: "test", meta: { ec2: full } };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("EC2Compute", async () => {
  it("advertises the expected capability flags", () => {
    const c = new EC2Compute(app);
    expect(c.kind).toBe("ec2");
    expect(c.capabilities).toEqual({
      snapshot: true,
      pool: true,
      networkIsolation: true,
      provisionLatency: "minutes",
    });
  });

  describe("provision", async () => {
    it("runs buildUserData -> provisionStack -> ssmCheck poll -> cloud-init poll -> allocatePort -> startPortForward -> health poll", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      const handle = await c.provision({ tags: { name: "test" }, size: "l", arch: "arm" });

      const fnOrder = calls
        .map((call) => call.fn)
        .filter((fn) => fn !== "ssmExec" && fn !== "fetchHealth" && fn !== "ssmCheckInstance");
      expect(fnOrder).toEqual([
        "buildUserData",
        "provisionStack",
        "poll", // SSM agent readiness
        "poll", // cloud-init ready marker
        "allocatePort",
        "startPortForward",
        "poll", // arkd health
      ]);

      expect(handle.kind).toBe("ec2");
      expect(handle.name).toBe("test");
      const meta = (handle.meta as { ec2: EC2HandleMeta }).ec2;
      expect(meta.instanceId).toBe("i-abc123");
      expect(meta.publicIp).toBe("1.2.3.4");
      expect(meta.arkdLocalPort).toBe(54321);
      expect(meta.portForwardPid).toBe(99999);
      expect(meta.region).toBe("us-east-1");
      expect(meta.sgId).toBe("sg-0001");
      expect(meta.size).toBe("l");
      expect(meta.arch).toBe("arm");
      expect(meta.stackName).toBe("ark-compute-test");
    });

    it("forwards cfg (region, awsProfile, idleMinutes, isolation) through to buildUserData + provisionStack", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      await c.provision({
        tags: { name: "test" },
        config: {
          region: "eu-west-1",
          awsProfile: "yt",
          idleMinutes: 30,
          isolation: "worktree",
          conductorUrl: "http://ark.local:19100",
        },
      });

      const buildCall = calls.find((call) => call.fn === "buildUserData")!;
      expect(buildCall.args[0]).toEqual({
        idleMinutes: 30,
        isolation: "worktree",
        conductorUrl: "http://ark.local:19100",
      });

      const provisionCall = calls.find((call) => call.fn === "provisionStack")!;
      const stackOpts = provisionCall.args[1] as Record<string, unknown>;
      expect(stackOpts.region).toBe("eu-west-1");
      expect(stackOpts.awsProfile).toBe("yt");
      expect(stackOpts.size).toBe("m");
      expect(stackOpts.arch).toBe("x64");
      // sshKeyPath is gone -- pure SSM, no key.
      expect(stackOpts.sshKeyPath).toBeUndefined();
    });

    it("opens the port-forward to ARKD_REMOTE_PORT on the returned instance_id", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      await c.provision({
        tags: { name: "test" },
        config: { region: "us-west-2", awsProfile: "yt" },
      });

      const tunnelCall = calls.find((call) => call.fn === "startPortForward")!;
      expect(tunnelCall.args[0]).toEqual({
        instanceId: "i-abc123",
        region: "us-west-2",
        awsProfile: "yt",
        localPort: 54321,
        remotePort: ARKD_REMOTE_PORT,
      });
    });

    it("throws and tears the port-forward down if arkd never responds", async () => {
      const { helpers, calls } = makeHelpers({ healthy: false });
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      (await expect(c.provision({ tags: { name: "test" } }))).rejects.toThrow(/arkd never became reachable/);

      // The forward must have been killed so we don't leak the process.
      const killCalls = calls.filter((call) => call.fn === "killPortForward");
      expect(killCalls.length).toBe(1);
      expect(killCalls[0].args[0]).toBe(99999);
    });

    it("propagates provisionStack errors", async () => {
      const { helpers } = makeHelpers({ provisionError: new Error("quota exceeded") });
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      (await expect(c.provision({ tags: { name: "test" } }))).rejects.toThrow("quota exceeded");
    });
  });

  describe("getArkdUrl", () => {
    it("returns the local tunnel endpoint, not the instance IP", () => {
      const c = new EC2Compute(app);
      const handle = makeProvisionedHandle({ arkdLocalPort: 23456 });
      expect(c.getArkdUrl(handle)).toBe("http://localhost:23456");
    });

    it("throws if the handle has no ec2 meta (misuse)", () => {
      const c = new EC2Compute(app);
      const bogus: ComputeHandle = { kind: "ec2", name: "test", meta: {} };
      expect(() => c.getArkdUrl(bogus)).toThrow(/missing meta.ec2/);
    });
  });

  describe("start", async () => {
    it("calls StartInstances, re-opens the port-forward, and waits for arkd health", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      const handle = makeProvisionedHandle({ portForwardPid: 11111 });
      await c.start(handle);

      const fnOrder = calls.map((call) => call.fn);
      expect(fnOrder).toContain("startInstance");
      expect(fnOrder).toContain("startPortForward");

      // Any pre-existing forward PID must have been torn down before the
      // fresh `startPortForward` call. Find both and check order.
      const killIdx = calls.findIndex((call) => call.fn === "killPortForward");
      const openIdx = calls.findIndex((call) => call.fn === "startPortForward");
      expect(killIdx).toBeLessThan(openIdx);
      expect(calls[killIdx].args[0]).toBe(11111);

      // The handle's meta is mutated in place so callers see the new PID.
      const meta = (handle.meta as { ec2: EC2HandleMeta }).ec2;
      expect(meta.portForwardPid).toBe(99999);
    });

    it("re-opens the SSM port-forward keyed off instance_id even when no IP is available", async () => {
      // Pre-fix this threw `EC2Compute.start: instance i-abc has no IP after
      // start`. Under SSM, the canonical address is the instance_id; IPs are
      // informational. The forward still opens cleanly.
      const { helpers, calls } = makeHelpers({ startIp: { publicIp: null, privateIp: null } });
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      await c.start(makeProvisionedHandle({ portForwardPid: null }));

      const tunnelCall = calls.find((call) => call.fn === "startPortForward")!;
      const tunnelArgs = tunnelCall.args[0] as { instanceId: string; region: string };
      expect(tunnelArgs.instanceId).toBe("i-abc123");
      expect(tunnelArgs.region).toBe("us-east-1");
    });

    it("tears the new port-forward down if arkd never comes back", async () => {
      const { helpers, calls } = makeHelpers({ healthy: false });
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      const handle = makeProvisionedHandle({ portForwardPid: null });
      (await expect(c.start(handle))).rejects.toThrow(/arkd never came back/);

      // Exactly one kill -- the fresh forward we spawned. The pre-existing
      // PID was null so we didn't try to kill anything first.
      const kills = calls.filter((call) => call.fn === "killPortForward");
      expect(kills.length).toBe(1);
      expect(kills[0].args[0]).toBe(99999);
    });
  });

  describe("stop", async () => {
    it("kills the port-forward and then calls StopInstances", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      const handle = makeProvisionedHandle({ portForwardPid: 7777 });
      await c.stop(handle);

      const fnOrder = calls.map((call) => call.fn);
      const killIdx = fnOrder.indexOf("killPortForward");
      const stopIdx = fnOrder.indexOf("stopInstance");
      expect(killIdx).toBeGreaterThanOrEqual(0);
      expect(stopIdx).toBeGreaterThanOrEqual(0);
      expect(killIdx).toBeLessThan(stopIdx);
      expect(calls[killIdx].args[0]).toBe(7777);

      // PID is cleared on the handle so a later start() doesn't double-kill.
      const meta = (handle.meta as { ec2: EC2HandleMeta }).ec2;
      expect(meta.portForwardPid).toBeNull();
    });

    it("skips killPortForward when there is no live PID", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      await c.stop(makeProvisionedHandle({ portForwardPid: null }));
      expect(calls.find((call) => call.fn === "killPortForward")).toBeUndefined();
      expect(calls.find((call) => call.fn === "stopInstance")).toBeDefined();
    });
  });

  describe("destroy", async () => {
    it("kills the port-forward, then calls destroyStack with the stored ids", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      const handle = makeProvisionedHandle({ portForwardPid: 5555 });
      await c.destroy(handle);

      const killIdx = calls.findIndex((call) => call.fn === "killPortForward");
      const destroyIdx = calls.findIndex((call) => call.fn === "destroyStack");
      expect(killIdx).toBeLessThan(destroyIdx);
      expect(calls[killIdx].args[0]).toBe(5555);

      const destroyCall = calls[destroyIdx];
      expect(destroyCall.args[0]).toBe("test");
      expect(destroyCall.args[1]).toMatchObject({
        region: "us-east-1",
        instance_id: "i-abc123",
        sg_id: "sg-0001",
        stackName: "ark-compute-test",
      });
    });

    it("throws if the handle has no ec2 meta (misuse)", async () => {
      const { helpers } = makeHelpers();
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      const bogus: ComputeHandle = { kind: "ec2", name: "test", meta: {} };
      (await expect(c.destroy(bogus))).rejects.toThrow(/missing meta.ec2/);
    });
  });

  describe("ensureReachable", async () => {
    // The two tests below exercise the idempotency claim that the
    // Compute.ensureReachable contract makes:
    //   1. healthy reuse -- second call must NOT spawn a fresh port-forward.
    //   2. stale-PID kill + respawn -- when /health probes false, the
    //      old PID must be killed AND a fresh startPortForward happen.

    it("each call spawns a fresh tunnel; previously-recorded forward is left alone (#423)", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      const handle = makeProvisionedHandle({ portForwardPid: 12345, arkdLocalPort: 60001 });

      // First call -- always allocates a new tunnel, never reuses the
      // recorded one. Per-session isolation #423: reuse caused multiple
      // sessions to share a tunnel that one of them would later see as
      // dead through compute-config staleness.
      await c.ensureReachable!(handle, { app, sessionId: "s-1" });
      let openCalls = calls.filter((call) => call.fn === "startPortForward");
      expect(openCalls.length).toBe(1);

      // Second call -- another fresh tunnel.
      await c.ensureReachable!(handle, { app, sessionId: "s-2" });
      openCalls = calls.filter((call) => call.fn === "startPortForward");
      expect(openCalls.length).toBe(2);

      // The kill helper must NOT have fired here. Killing the prior
      // forward could kill a sibling session's still-active tunnel.
      // Per-session cleanup is a separate concern.
      const kills = calls.filter((call) => call.fn === "killPortForward");
      expect(kills.length).toBe(0);
    });

    it("each call writes its own (port, pid) to the compute meta (#423)", async () => {
      let openCount = 0;
      const allocPorts = [60100, 60101, 60102];

      const helpers: EC2ComputeHelpers = {
        ssmExec: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
        ssmCheckInstance: async () => true,
        ssmWaitForReady: async () => true,
        buildUserData: async () => "",
        provisionStack: async () => ({ ip: null, instance_id: "i", stack_name: "s" }),
        destroyStack: async () => {},
        startInstance: async () => ({ publicIp: null, privateIp: null }),
        stopInstance: async () => {},
        describeInstance: async () => ({ publicIp: null, privateIp: null }),
        startPortForward: () => {
          openCount += 1;
          return { pid: 90000 + openCount };
        },
        killPortForward: () => {},
        allocatePort: async () => allocPorts[openCount] ?? 60999,
        fetchHealth: async () => true,
        poll: async (check) => {
          for (let i = 0; i < 3; i++) if (await check()) return true;
          return false;
        },
      };

      const c = new EC2Compute(app);
      c.setHelpersForTesting(helpers);

      const handle = makeProvisionedHandle({ portForwardPid: 12345, arkdLocalPort: 60001 });

      await c.ensureReachable!(handle, { app, sessionId: "s-1" });
      const meta1 = (handle.meta as { ec2: EC2HandleMeta }).ec2;
      expect(meta1.arkdLocalPort).toBe(60100);
      expect(meta1.portForwardPid).toBe(90001);

      await c.ensureReachable!(handle, { app, sessionId: "s-2" });
      const meta2 = (handle.meta as { ec2: EC2HandleMeta }).ec2;
      expect(meta2.arkdLocalPort).toBe(60101);
      expect(meta2.portForwardPid).toBe(90002);

      // Two `startPortForward` calls; zero kills (sibling session
      // cleanup is out of scope here).
      expect(openCount).toBe(2);
    });
  });

  describe("snapshot / restore", async () => {
    it("throws NotSupportedError on snapshot (deferred)", async () => {
      const c = new EC2Compute(app);
      (await expect(c.snapshot(makeProvisionedHandle()))).rejects.toBeInstanceOf(NotSupportedError);
    });

    it("throws NotSupportedError on restore (deferred)", async () => {
      const c = new EC2Compute(app);
      const snap: Snapshot = {
        id: "noop",
        computeKind: "ec2",
        createdAt: new Date().toISOString(),
        sizeBytes: 0,
        metadata: {},
      };
      (await expect(c.restore(snap))).rejects.toBeInstanceOf(NotSupportedError);
    });

    it("still reports capabilities.snapshot = true so dispatch advertises the eventual shape", () => {
      const c = new EC2Compute(app);
      expect(c.capabilities.snapshot).toBe(true);
    });
  });
});
