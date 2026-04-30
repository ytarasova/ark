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

  it("getArkdUrl uses compute IP when present (legacy path)", () => {
    // arkd HTTP from the conductor still goes via the legacy ip field when
    // it's set. SSM-only deployments rely on the SSH-tunnel route exposed by
    // EC2Compute (packages/compute/core/ec2.ts) instead.
    const compute = makeCompute({ config: { instance_id: "i-x", region: "us-east-1", ip: "10.0.1.5" } });
    expect(provider.getArkdUrl(compute)).toBe("http://10.0.1.5:19300");
  });

  it("getArkdUrl prefers arkd_url from config", () => {
    const compute = makeCompute({
      config: { instance_id: "i-x", region: "us-east-1", arkd_url: "http://custom:9999" },
    });
    expect(provider.getArkdUrl(compute)).toBe("http://custom:9999");
  });

  it("getArkdUrl throws when no arkd_url and no ip", () => {
    const compute = makeCompute({ config: { instance_id: "i-x", region: "us-east-1" } });
    try {
      provider.getArkdUrl(compute);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain("no IP");
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

  it("getAttachCommand includes ssh with SSM ProxyCommand", () => {
    const cmd = provider.getAttachCommand(makeCompute(), {
      session_id: "ark-s-test",
    } as Session);
    expect(cmd[0]).toBe("ssh");
    expect(cmd).toContain("ubuntu@i-test123");
    // ProxyCommand wraps SSH in an SSM Session Manager tunnel.
    expect(cmd.some((a) => a.startsWith("ProxyCommand=aws ssm start-session"))).toBe(true);
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
