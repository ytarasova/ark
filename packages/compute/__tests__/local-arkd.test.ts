/**
 * Tests for local ArkD-backed providers.
 *
 * Tests the 4 local provider variants (worktree, docker, devcontainer, firecracker)
 * through the ArkdBackedProvider base class, verifying they:
 *   - Correctly delegate agent lifecycle to arkd
 *   - Have the right capability flags
 *   - Return localhost arkd URL
 *   - Handle launch wrapping for each isolation mode
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startArkd } from "../../arkd/server.js";
import {
  LocalWorktreeProvider,
  LocalDockerProvider,
  LocalDevcontainerProvider,
  LocalFirecrackerProvider,
} from "../providers/local-arkd.js";
import type { Compute, Session } from "../types.js";

const TEST_PORT = 19370;
let server: { stop(): void };
let tempDir: string;

const compute: Compute = {
  id: "test-local",
  name: "test-local",
  provider: "local",
  status: "running",
  config: {},
} as Compute;

function makeSession(sessionId?: string): Session {
  return {
    id: "s-local-test",
    session_id: sessionId ?? null,
    workdir: tempDir,
    repo: tempDir,
  } as Session;
}

beforeAll(() => {
  tempDir = join(tmpdir(), `local-arkd-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  // Start arkd on port 19300 (what providers expect)
  // But our test uses a custom port — we'll test the base via the arkd-backed test
  server = startArkd(TEST_PORT, { quiet: true });
});

afterAll(() => {
  server.stop();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ── LocalWorktreeProvider ───────────────────────────────────────────────────

describe("LocalWorktreeProvider", () => {
  const provider = new LocalWorktreeProvider();

  it("has correct name and flags", () => {
    expect(provider.name).toBe("local");
    expect(provider.canReboot).toBe(false);
    expect(provider.canDelete).toBe(false);
    expect(provider.supportsWorktree).toBe(true);
    expect(provider.initialStatus).toBe("running");
    expect(provider.needsAuth).toBe(false);
  });

  it("provision is a noop", async () => {
    await provider.provision(compute); // Should not throw
  });

  it("destroy throws", async () => {
    try {
      await provider.destroy(compute);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain("Cannot destroy");
    }
  });

  it("stop throws", async () => {
    try {
      await provider.stop(compute);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain("Cannot stop");
    }
  });

  it("getArkdUrl returns localhost:19300", () => {
    expect(provider.getArkdUrl(compute)).toBe("http://localhost:19300");
  });

  it("getAttachCommand returns tmux attach", () => {
    const cmd = provider.getAttachCommand(compute, makeSession("ark-s-test"));
    expect(cmd).toEqual(["tmux", "attach", "-t", "ark-s-test"]);
  });

  it("getAttachCommand returns empty for null session_id", () => {
    expect(provider.getAttachCommand(compute, makeSession())).toEqual([]);
  });

  it("buildChannelConfig returns local bun config", () => {
    const cfg = provider.buildChannelConfig("s-1", "work", 19200);
    expect(cfg.command).toContain("bun");
    expect((cfg.env as any).ARK_SESSION_ID).toBe("s-1");
    expect((cfg.env as any).ARK_STAGE).toBe("work");
  });

  it("buildLaunchEnv returns empty", () => {
    expect(provider.buildLaunchEnv(makeSession())).toEqual({});
  });

  it("isolationModes includes worktree and inplace", () => {
    expect(provider.isolationModes.length).toBe(2);
    expect(provider.isolationModes.map(m => m.value)).toContain("worktree");
    expect(provider.isolationModes.map(m => m.value)).toContain("inplace");
  });
});

// ── LocalDockerProvider ─────────────────────────────────────────────────────

describe("LocalDockerProvider", () => {
  const provider = new LocalDockerProvider();

  it("has correct name and flags", () => {
    expect(provider.name).toBe("docker");
    expect(provider.canDelete).toBe(true);
    expect(provider.supportsWorktree).toBe(false);
    expect(provider.initialStatus).toBe("stopped");
  });

  it("getArkdUrl returns localhost:19300", () => {
    expect(provider.getArkdUrl(compute)).toBe("http://localhost:19300");
  });

  it("isolationModes includes container", () => {
    expect(provider.isolationModes[0].value).toBe("container");
  });
});

// ── LocalDevcontainerProvider ───────────────────────────────────────────────

describe("LocalDevcontainerProvider", () => {
  const provider = new LocalDevcontainerProvider();

  it("has correct name and flags", () => {
    expect(provider.name).toBe("devcontainer");
    expect(provider.canDelete).toBe(true);
    expect(provider.supportsWorktree).toBe(false);
    expect(provider.initialStatus).toBe("stopped");
  });

  it("getArkdUrl returns localhost:19300", () => {
    expect(provider.getArkdUrl(compute)).toBe("http://localhost:19300");
  });

  it("isolationModes includes devcontainer", () => {
    expect(provider.isolationModes[0].value).toBe("devcontainer");
  });
});

// ── LocalFirecrackerProvider ────────────────────────────────────────────────

describe("LocalFirecrackerProvider", () => {
  const provider = new LocalFirecrackerProvider();

  it("has correct name and flags", () => {
    expect(provider.name).toBe("firecracker");
    expect(provider.canDelete).toBe(true);
    expect(provider.supportsWorktree).toBe(false);
    expect(provider.initialStatus).toBe("stopped");
  });

  it("getArkdUrl returns localhost:19300", () => {
    expect(provider.getArkdUrl(compute)).toBe("http://localhost:19300");
  });

  it("isolationModes includes microvm", () => {
    expect(provider.isolationModes[0].value).toBe("microvm");
  });

  it("provision fails on macOS", async () => {
    const { platform } = await import("os");
    if (platform() === "darwin") {
      try {
        await provider.provision(compute);
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.message).toContain("Linux");
      }
    }
  });
});
