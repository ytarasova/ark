/**
 * EC2Compute unit tests.
 *
 * The whole AWS + SSH surface is faked via `setHelpersForTesting` so no
 * network / subprocess is touched. Each test records the sequence of helper
 * calls so we can assert both behaviour and lifecycle order.
 */

import { describe, it, expect } from "bun:test";

import { EC2Compute, type EC2ComputeHelpers, type EC2HandleMeta, ARKD_REMOTE_PORT } from "../core/ec2.js";
import { NotSupportedError, type ComputeHandle, type Snapshot } from "../core/types.js";

// ── Test doubles ─────────────────────────────────────────────────────────────

type Call = { fn: string; args: unknown[] };

interface StubOpts {
  /** If set, provisionStack returns this IP. Default "1.2.3.4". */
  ip?: string | null;
  /** If set, sshExec returns this stdout + exit 0 for the ready-marker probe. */
  readyMarker?: boolean;
  /** If true, fetchHealth always returns true. */
  healthy?: boolean;
  /** Pre-allocated port the stub will hand out. */
  localPort?: number;
  /** Override spawned tunnel PID. */
  tunnelPid?: number;
  /** startInstance response. */
  startIp?: { publicIp: string | null; privateIp: string | null };
  /** Force provisionStack to throw. */
  provisionError?: Error;
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
    generateSshKey: async (hostName) => {
      record("generateSshKey")(hostName);
      return {
        publicKeyPath: `/tmp/keys/ark-${hostName}.pub`,
        privateKeyPath: `/tmp/keys/ark-${hostName}`,
      };
    },
    sshExec: async (key, host, cmd, o) => {
      record("sshExec")(key, host, cmd, o);
      // Ready-marker probe -- return "ready" if readyMarker is truthy (default).
      if (cmd.includes(".ark-ready")) {
        return { stdout: opts.readyMarker === false ? "" : "ready\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "ok\n", stderr: "", exitCode: 0 };
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
        key_name: `ark-${hostName}`,
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
    openSshTunnel: (tunnelOpts) => {
      record("openSshTunnel")(tunnelOpts);
      return tunnelPid;
    },
    killSshTunnel: (pid) => {
      record("killSshTunnel")(pid);
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
    sshPid: 99999,
    sshKeyPath: "/tmp/keys/ark-test",
    region: "us-east-1",
    stackName: "ark-compute-test",
    sgId: "sg-0001",
    keyName: "ark-test",
    size: "m",
    arch: "x64",
    ...meta,
  };
  return { kind: "ec2", name: "test", meta: { ec2: full } };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("EC2Compute", () => {
  it("advertises the expected capability flags", () => {
    const c = new EC2Compute();
    expect(c.kind).toBe("ec2");
    expect(c.capabilities).toEqual({
      snapshot: true,
      pool: true,
      networkIsolation: true,
      provisionLatency: "minutes",
    });
  });

  describe("provision", () => {
    it("runs generateSshKey -> buildUserData -> provisionStack -> SSH poll -> cloud-init poll -> allocatePort -> openSshTunnel -> health poll", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      const handle = await c.provision({ tags: { name: "test" }, size: "l", arch: "arm" });

      const fnOrder = calls.map((call) => call.fn).filter((fn) => fn !== "sshExec" && fn !== "fetchHealth");
      expect(fnOrder).toEqual([
        "generateSshKey",
        "buildUserData",
        "provisionStack",
        "poll", // SSH readiness
        "poll", // cloud-init ready marker
        "allocatePort",
        "openSshTunnel",
        "poll", // arkd health
      ]);

      expect(handle.kind).toBe("ec2");
      expect(handle.name).toBe("test");
      const meta = (handle.meta as { ec2: EC2HandleMeta }).ec2;
      expect(meta.instanceId).toBe("i-abc123");
      expect(meta.publicIp).toBe("1.2.3.4");
      expect(meta.arkdLocalPort).toBe(54321);
      expect(meta.sshPid).toBe(99999);
      expect(meta.region).toBe("us-east-1");
      expect(meta.sgId).toBe("sg-0001");
      expect(meta.keyName).toBe("ark-test");
      expect(meta.size).toBe("l");
      expect(meta.arch).toBe("arm");
      expect(meta.stackName).toBe("ark-compute-test");
      expect(meta.sshKeyPath).toBe("/tmp/keys/ark-test");
    });

    it("forwards cfg (region, awsProfile, idleMinutes, isolation) through to buildUserData + provisionStack", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute();
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
      expect(stackOpts.sshKeyPath).toBe("/tmp/keys/ark-test");
    });

    it("opens the tunnel to ARKD_REMOTE_PORT on the returned instance IP", async () => {
      const { helpers, calls } = makeHelpers({ ip: "203.0.113.42" });
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      await c.provision({ tags: { name: "test" } });

      const tunnelCall = calls.find((call) => call.fn === "openSshTunnel")!;
      expect(tunnelCall.args[0]).toEqual({
        keyPath: "/tmp/keys/ark-test",
        ip: "203.0.113.42",
        localPort: 54321,
        remotePort: ARKD_REMOTE_PORT,
      });
    });

    it("throws and tears the tunnel down if arkd never responds", async () => {
      const { helpers, calls } = makeHelpers({ healthy: false });
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      await expect(c.provision({ tags: { name: "test" } })).rejects.toThrow(/arkd never became reachable/);

      // The tunnel must have been killed so we don't leak the ssh process.
      const killCalls = calls.filter((call) => call.fn === "killSshTunnel");
      expect(killCalls.length).toBe(1);
      expect(killCalls[0].args[0]).toBe(99999);
    });

    it("throws if provisionStack returns no IP", async () => {
      const { helpers } = makeHelpers({ ip: null });
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      await expect(c.provision({ tags: { name: "test" } })).rejects.toThrow(/no IP/);
    });

    it("propagates provisionStack errors", async () => {
      const { helpers } = makeHelpers({ provisionError: new Error("quota exceeded") });
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      await expect(c.provision({ tags: { name: "test" } })).rejects.toThrow("quota exceeded");
    });
  });

  describe("getArkdUrl", () => {
    it("returns the local tunnel endpoint, not the instance IP", () => {
      const c = new EC2Compute();
      const handle = makeProvisionedHandle({ arkdLocalPort: 23456 });
      expect(c.getArkdUrl(handle)).toBe("http://localhost:23456");
    });

    it("throws if the handle has no ec2 meta (misuse)", () => {
      const c = new EC2Compute();
      const bogus: ComputeHandle = { kind: "ec2", name: "test", meta: {} };
      expect(() => c.getArkdUrl(bogus)).toThrow(/missing meta.ec2/);
    });
  });

  describe("start", () => {
    it("calls StartInstances, re-opens the tunnel, and waits for arkd health", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      const handle = makeProvisionedHandle({ sshPid: 11111 });
      await c.start(handle);

      const fnOrder = calls.map((call) => call.fn);
      expect(fnOrder).toContain("startInstance");
      expect(fnOrder).toContain("openSshTunnel");

      // Any pre-existing tunnel PID must have been torn down before the
      // fresh `openSshTunnel` call. Find both and check order.
      const killIdx = calls.findIndex((call) => call.fn === "killSshTunnel");
      const openIdx = calls.findIndex((call) => call.fn === "openSshTunnel");
      expect(killIdx).toBeLessThan(openIdx);
      expect(calls[killIdx].args[0]).toBe(11111);

      // The handle's meta is mutated in place so callers see the new PID.
      const meta = (handle.meta as { ec2: EC2HandleMeta }).ec2;
      expect(meta.sshPid).toBe(99999);
    });

    it("throws if the instance has no IP after start", async () => {
      const { helpers } = makeHelpers({ startIp: { publicIp: null, privateIp: null } });
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      await expect(c.start(makeProvisionedHandle())).rejects.toThrow(/no IP after start/);
    });

    it("falls back to privateIp when publicIp is null", async () => {
      const { helpers, calls } = makeHelpers({ startIp: { publicIp: null, privateIp: "10.0.0.99" } });
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      await c.start(makeProvisionedHandle({ sshPid: null }));

      const tunnelCall = calls.find((call) => call.fn === "openSshTunnel")!;
      expect((tunnelCall.args[0] as { ip: string }).ip).toBe("10.0.0.99");
    });

    it("tears the new tunnel down if arkd never comes back", async () => {
      const { helpers, calls } = makeHelpers({ healthy: false });
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      const handle = makeProvisionedHandle({ sshPid: null });
      await expect(c.start(handle)).rejects.toThrow(/arkd never came back/);

      // Exactly one kill -- the fresh tunnel we spawned. The pre-existing
      // PID was null so we didn't try to kill anything first.
      const kills = calls.filter((call) => call.fn === "killSshTunnel");
      expect(kills.length).toBe(1);
      expect(kills[0].args[0]).toBe(99999);
    });
  });

  describe("stop", () => {
    it("kills the tunnel and then calls StopInstances", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      const handle = makeProvisionedHandle({ sshPid: 7777 });
      await c.stop(handle);

      const fnOrder = calls.map((call) => call.fn);
      const killIdx = fnOrder.indexOf("killSshTunnel");
      const stopIdx = fnOrder.indexOf("stopInstance");
      expect(killIdx).toBeGreaterThanOrEqual(0);
      expect(stopIdx).toBeGreaterThanOrEqual(0);
      expect(killIdx).toBeLessThan(stopIdx);
      expect(calls[killIdx].args[0]).toBe(7777);

      // PID is cleared on the handle so a later start() doesn't double-kill.
      const meta = (handle.meta as { ec2: EC2HandleMeta }).ec2;
      expect(meta.sshPid).toBeNull();
    });

    it("skips killSshTunnel when there is no live PID", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      await c.stop(makeProvisionedHandle({ sshPid: null }));
      expect(calls.find((call) => call.fn === "killSshTunnel")).toBeUndefined();
      expect(calls.find((call) => call.fn === "stopInstance")).toBeDefined();
    });
  });

  describe("destroy", () => {
    it("kills the tunnel, then calls destroyStack with the stored ids", async () => {
      const { helpers, calls } = makeHelpers();
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      const handle = makeProvisionedHandle({ sshPid: 5555 });
      await c.destroy(handle);

      const killIdx = calls.findIndex((call) => call.fn === "killSshTunnel");
      const destroyIdx = calls.findIndex((call) => call.fn === "destroyStack");
      expect(killIdx).toBeLessThan(destroyIdx);
      expect(calls[killIdx].args[0]).toBe(5555);

      const destroyCall = calls[destroyIdx];
      expect(destroyCall.args[0]).toBe("test");
      expect(destroyCall.args[1]).toMatchObject({
        region: "us-east-1",
        instance_id: "i-abc123",
        sg_id: "sg-0001",
        key_name: "ark-test",
        stackName: "ark-compute-test",
      });
    });

    it("throws if the handle has no ec2 meta (misuse)", async () => {
      const { helpers } = makeHelpers();
      const c = new EC2Compute();
      c.setHelpersForTesting(helpers);

      const bogus: ComputeHandle = { kind: "ec2", name: "test", meta: {} };
      await expect(c.destroy(bogus)).rejects.toThrow(/missing meta.ec2/);
    });
  });

  describe("snapshot / restore", () => {
    it("throws NotSupportedError on snapshot (deferred)", async () => {
      const c = new EC2Compute();
      await expect(c.snapshot(makeProvisionedHandle())).rejects.toBeInstanceOf(NotSupportedError);
    });

    it("throws NotSupportedError on restore (deferred)", async () => {
      const c = new EC2Compute();
      const snap: Snapshot = {
        id: "noop",
        computeKind: "ec2",
        createdAt: new Date().toISOString(),
        sizeBytes: 0,
        metadata: {},
      };
      await expect(c.restore(snap)).rejects.toBeInstanceOf(NotSupportedError);
    });

    it("still reports capabilities.snapshot = true so dispatch advertises the eventual shape", () => {
      const c = new EC2Compute();
      expect(c.capabilities.snapshot).toBe(true);
    });
  });
});
