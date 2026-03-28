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
import type { Compute } from "../types.js";

function makeCompute(overrides?: Partial<Compute>): Compute {
  return {
    id: "test-remote",
    name: "test-remote",
    provider: "ec2",
    status: "running",
    config: { ip: "10.0.1.5" },
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

  it("getArkdUrl uses compute IP", () => {
    expect(provider.getArkdUrl(makeCompute())).toBe("http://10.0.1.5:19300");
  });

  it("getArkdUrl prefers arkd_url from config", () => {
    const compute = makeCompute({ config: { ip: "10.0.1.5", arkd_url: "http://custom:9999" } } as any);
    expect(provider.getArkdUrl(compute)).toBe("http://custom:9999");
  });

  it("getArkdUrl throws when no IP", () => {
    const compute = makeCompute({ config: {} } as any);
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
      const env = provider.buildLaunchEnv({} as any);
      expect(env.ANTHROPIC_API_KEY).toBe("test-key");
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("buildChannelConfig uses remote ark binary", () => {
    const cfg = provider.buildChannelConfig("s-1", "work", 19200);
    expect(cfg.command).toContain("ark");
    expect((cfg.env as any).ARK_SESSION_ID).toBe("s-1");
  });

  it("getAttachCommand includes ssh", () => {
    const cmd = provider.getAttachCommand(makeCompute(), {
      session_id: "ark-s-test",
    } as any);
    expect(cmd[0]).toBe("ssh");
    expect(cmd).toContain("ubuntu@10.0.1.5");
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

  it("getArkdUrl uses compute IP", () => {
    expect(provider.getArkdUrl(makeCompute())).toBe("http://10.0.1.5:19300");
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

  it("getArkdUrl uses compute IP", () => {
    expect(provider.getArkdUrl(makeCompute())).toBe("http://10.0.1.5:19300");
  });
});
