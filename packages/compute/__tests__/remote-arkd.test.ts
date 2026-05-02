/**
 * Tests for remote ArkD-backed providers.
 *
 * Tests the 4 remote provider variants (worktree, docker, devcontainer, firecracker)
 * for correct capability flags, isolation types, and arkd URL resolution.
 *
 * Note: actual EC2 provisioning is not tested here (requires AWS credentials).
 */

import { describe, it, expect } from "bun:test";
import {
  RemoteWorktreeProvider,
  RemoteDockerProvider,
  RemoteDevcontainerProvider,
  RemoteFirecrackerProvider,
} from "../providers/remote-arkd.js";
import { DeferredPlacementCtx } from "../../core/secrets/deferred-placement-ctx.js";
import type { Compute, Session } from "../types.js";

function makeCompute(overrides?: Partial<Compute>): Compute {
  return {
    name: "test-remote",
    provider: "ec2",
    status: "running",
    config: { instance_id: "i-test123", region: "us-east-1" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Compute;
}

// ── RemoteWorktreeProvider ──────────────────────────────────────────────────

describe("RemoteWorktreeProvider", () => {
  const provider = new RemoteWorktreeProvider();

  it("has correct name and flags", () => {
    expect(provider.name).toBe("ec2");
    expect(provider.canReboot).toBe(true);
    expect(provider.canDelete).toBe(true);
    expect(provider.supportsWorktree).toBe(false);
    expect(provider.initialStatus).toBe("stopped");
    expect(provider.needsAuth).toBe(true);
  });

  it("getArkdUrl uses compute IP when present (legacy path, in-VPC conductor only)", () => {
    // Legacy back-compat: in-VPC conductors can still hit the private IP
    // directly. SSM-only deployments use the forward-tunnel path below.
    const compute = makeCompute({ config: { instance_id: "i-x", region: "us-east-1", ip: "10.0.1.5" } });
    expect(provider.getArkdUrl(compute)).toBe("http://10.0.1.5:19300");
  });

  it("getArkdUrl uses arkd_url when no forward port is set (legacy in-VPC path)", () => {
    const compute = makeCompute({
      config: { instance_id: "i-x", region: "us-east-1", arkd_url: "http://custom:9999" },
    });
    expect(provider.getArkdUrl(compute)).toBe("http://custom:9999");
  });

  it("getArkdUrl prefers arkd_local_forward_port over a stale arkd_url", () => {
    // `provision()` writes `arkd_url: http://<private-ip>:19300` for legacy
    // back-compat. After commit 7a888f74 (no public IPs) that URL is not
    // reachable from the conductor. `prepareRemoteEnvironment` sets up an
    // SSM port-forward and stores the local port; the forward port
    // must win over the stale `arkd_url` so dispatch actually reaches arkd.
    const compute = makeCompute({
      config: {
        instance_id: "i-x",
        region: "us-east-1",
        ip: "10.72.217.109",
        arkd_url: "http://10.72.217.109:19300",
        arkd_local_forward_port: 41234,
      },
    });
    expect(provider.getArkdUrl(compute)).toBe("http://localhost:41234");
  });

  it("getArkdUrl uses arkd_local_forward_port over the legacy ip field", () => {
    const compute = makeCompute({
      config: {
        instance_id: "i-x",
        region: "us-east-1",
        ip: "10.72.217.109",
        arkd_local_forward_port: 41234,
      },
    });
    expect(provider.getArkdUrl(compute)).toBe("http://localhost:41234");
  });

  it("getArkdUrl uses arkd_local_forward_port when no ip is set", () => {
    const compute = makeCompute({
      config: { instance_id: "i-x", region: "us-east-1", arkd_local_forward_port: 41234 },
    });
    expect(provider.getArkdUrl(compute)).toBe("http://localhost:41234");
  });

  it("getArkdUrl throws when no arkd_url, no forward port, and no ip", () => {
    const compute = makeCompute({ config: { instance_id: "i-x", region: "us-east-1" } });
    try {
      provider.getArkdUrl(compute);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toMatch(/no arkd_local_forward_port, arkd_url, or ip/);
    }
  });

  it("isolationType is worktree", () => {
    expect(provider.isolationType).toBe("worktree");
  });

  it("buildLaunchEnv forwards auth tokens", () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const env = provider.buildLaunchEnv({} as Session);
      expect(env.ANTHROPIC_API_KEY).toBe("test-key");
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("buildChannelConfig uses remote ark binary", () => {
    const cfg = provider.buildChannelConfig("s-1", "work", 19200);
    expect(cfg.command).toContain("ark");
    expect((cfg.env as Record<string, string>).ARK_SESSION_ID).toBe("s-1");
  });

  it("getAttachCommand uses pure aws ssm start-session (no ssh)", () => {
    const cmd = provider.getAttachCommand(makeCompute(), {
      session_id: "ark-s-test",
    } as Session);
    expect(cmd[0]).toBe("aws");
    expect(cmd).toContain("ssm");
    expect(cmd).toContain("start-session");
    expect(cmd).toContain("--target");
    expect(cmd).toContain("i-test123");
    // The interactive command parameter carries the tmux attach.
    expect(cmd.some((a) => a.includes("tmux attach -t ark-s-test"))).toBe(true);
  });

  it("buildPlacementCtx returns a DeferredPlacementCtx even without an instance_id", async () => {
    // Regression: pre-fix this threw `Compute '<name>' has no IP -- cannot
    // build EC2 PlacementCtx`, breaking every dispatch where the compute
    // hadn't been provisioned at the time the dispatcher ran (which is
    // always, for stopped/destroyed computes -- the address only comes back
    // during provider.start inside provider.launch).
    const noTarget = makeCompute({ config: {} });
    const ctx = await provider.buildPlacementCtx({} as Session, noTarget);
    expect(ctx).toBeInstanceOf(DeferredPlacementCtx);
  });

  it("buildPlacementCtx returns a DeferredPlacementCtx when an instance_id is already set", async () => {
    // Even when the instance_id is known, we still hand back a deferred ctx
    // -- the provider's launch flow flushes it onto a real EC2PlacementCtx
    // post-`prepareRemoteEnvironment`. Pre-fix this returned an
    // EC2PlacementCtx directly; today the deferred contract is uniform.
    const ctx = await provider.buildPlacementCtx({} as Session, makeCompute());
    expect(ctx).toBeInstanceOf(DeferredPlacementCtx);
  });

  it("flushDeferredPlacement throws when ops are queued but instance_id is missing", async () => {
    // Regression: pre-fix this logged a warning and silently dropped the
    // queued ops, leaving the agent running without its ssh-private-key /
    // kubeconfig / generic-blob and surfacing no terminal status. The throw
    // propagates up to `provider.launch -> executor.launch -> dispatch-core`
    // so kickDispatch marks the dispatch failed.
    const ctx = new DeferredPlacementCtx();
    await ctx.writeFile("/home/ubuntu/.ssh/id_ed25519", 0o600, new Uint8Array([1, 2, 3]));
    const compute = makeCompute({ config: { region: "us-east-1" } }); // no instance_id
    const flush = (provider as any).flushDeferredPlacement.bind(provider);
    await expect(flush(compute, { placement: ctx } as any)).rejects.toThrow(/no instance_id/);
  });

  it("flushDeferredPlacement is a no-op when no ops are queued, even without instance_id", async () => {
    // Symmetric guard for the throw above: an empty queue should never
    // throw -- there's nothing to flush, and env-only sessions hit this
    // path constantly.
    const ctx = new DeferredPlacementCtx();
    ctx.setEnv("FOO", "bar"); // env only -- not queued
    const compute = makeCompute({ config: { region: "us-east-1" } }); // no instance_id
    const flush = (provider as any).flushDeferredPlacement.bind(provider);
    await flush(compute, { placement: ctx } as any); // must not throw
  });

  it("flushDeferredPlacement is a no-op when no deferred ctx is attached", async () => {
    // Sessions where the dispatcher's placement branch was disabled don't
    // attach a deferred ctx at all. The instance_id check shouldn't even
    // run -- the early return on the type guard handles it.
    const compute = makeCompute({ config: { region: "us-east-1" } }); // no instance_id
    const flush = (provider as any).flushDeferredPlacement.bind(provider);
    await flush(compute, { placement: undefined } as any); // must not throw
  });
});

// ── RemoteDockerProvider ────────────────────────────────────────────────────

describe("RemoteDockerProvider", () => {
  const provider = new RemoteDockerProvider();

  it("has correct name", () => {
    expect(provider.name).toBe("ec2-docker");
  });

  it("isolationType is docker", () => {
    expect(provider.isolationType).toBe("docker");
  });

  it("getArkdUrl uses compute IP when present (legacy path)", () => {
    const compute = makeCompute({ config: { instance_id: "i-x", region: "us-east-1", ip: "10.0.1.5" } });
    expect(provider.getArkdUrl(compute)).toBe("http://10.0.1.5:19300");
  });

  it("isolationModes includes container", () => {
    expect(provider.isolationModes[0].value).toBe("container");
  });
});

// ── RemoteDevcontainerProvider ──────────────────────────────────────────────

describe("RemoteDevcontainerProvider", () => {
  const provider = new RemoteDevcontainerProvider();

  it("has correct name", () => {
    expect(provider.name).toBe("ec2-devcontainer");
  });

  it("isolationType is devcontainer", () => {
    expect(provider.isolationType).toBe("devcontainer");
  });

  it("isolationModes includes devcontainer", () => {
    expect(provider.isolationModes[0].value).toBe("devcontainer");
  });
});

// ── RemoteFirecrackerProvider ───────────────────────────────────────────────

describe("RemoteFirecrackerProvider", () => {
  const provider = new RemoteFirecrackerProvider();

  it("has correct name", () => {
    expect(provider.name).toBe("ec2-firecracker");
  });

  it("isolationType is firecracker", () => {
    expect(provider.isolationType).toBe("firecracker");
  });

  it("isolationModes includes microvm", () => {
    expect(provider.isolationModes[0].value).toBe("microvm");
  });

  it("getArkdUrl uses compute IP when present (legacy path)", () => {
    const compute = makeCompute({ config: { instance_id: "i-x", region: "us-east-1", ip: "10.0.1.5" } });
    expect(provider.getArkdUrl(compute)).toBe("http://10.0.1.5:19300");
  });
});
