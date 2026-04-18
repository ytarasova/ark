/**
 * Tests for local ArkD-backed providers.
 *
 * Tests the 4 local provider variants through a real arkd instance,
 * verifying capability flags, arkd URL resolution, helper methods,
 * and actual agent lifecycle through ArkdClient.
 *
 * Docker/devcontainer/firecracker launch tests verify the wrapping
 * logic by checking the script content written to disk.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir, platform } from "os";
import { startArkd } from "../../arkd/server.js";
import { ArkdClient } from "../../arkd/client.js";
import {
  LocalWorktreeProvider,
  LocalDockerProvider,
  LocalDevcontainerProvider,
  LocalFirecrackerProvider,
} from "../providers/local-arkd.js";
import type { Compute, Session } from "../types.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";
import { allocatePort } from "../../core/__tests__/helpers/test-env.js";

// Local providers call getArkdUrl() which returns DEFAULT_ARKD_URL
// (localhost:19300). That constant is frozen at module load, so this test
// still has to exercise port 19300 -- we can't swap it out dynamically
// without rebuilding the providers. The beforeAll reuses an existing arkd
// on 19300 if it's already running, so parallel test runs that land on
// this file share one arkd instance which is fine for read-only probes.
const ARKD_PORT = 19300;
let server: { stop(): void };
let tempDir: string;
let client: ArkdClient;

const compute = {
  id: "test-local",
  name: "test-local",
  provider: "local",
  status: "running",
  config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as Compute;

function makeSession(sessionId?: string): Session {
  return {
    id: "s-local-test",
    session_id: sessionId ?? null,
    workdir: tempDir,
    repo: tempDir,
  } as Session;
}

let ownServer = false;

beforeAll(() => {
  tempDir = join(tmpdir(), `local-arkd-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    server = startArkd(ARKD_PORT, { quiet: true });
    ownServer = true;
  } catch {
    // Port already in use (e.g., real arkd running) -- reuse existing daemon
    console.log(`Port ${ARKD_PORT} in use, reusing existing arkd`);
  }
  client = new ArkdClient(`http://localhost:${ARKD_PORT}`);
});

afterAll(() => {
  if (ownServer) server?.stop();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* cleanup */
  }
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
    await provider.provision(compute);
  });

  it("destroy throws", async () => {
    try {
      await provider.destroy(compute);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain("Cannot destroy");
    }
  });

  it("start is a noop", async () => {
    await provider.start(compute);
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

  it("buildChannelConfig returns local bun config with correct env", () => {
    const cfg = provider.buildChannelConfig("s-1", "work", 19200, { conductorUrl: "http://localhost:19100" });
    expect(cfg.command).toContain("bun");
    const env = cfg.env as Record<string, string>;
    expect(env.ARK_SESSION_ID).toBe("s-1");
    expect(env.ARK_STAGE).toBe("work");
    expect(env.ARK_CHANNEL_PORT).toBe("19200");
    expect(env.ARK_CONDUCTOR_URL).toBe("http://localhost:19100");
  });

  it("buildLaunchEnv returns empty object", () => {
    expect(provider.buildLaunchEnv(makeSession())).toEqual({});
  });

  it("syncEnvironment is a noop", async () => {
    await provider.syncEnvironment(compute, { direction: "push" });
  });

  it("attach is a noop", async () => {
    await provider.attach(compute, makeSession());
  });

  it("isolationModes includes worktree and inplace", () => {
    expect(provider.isolationModes.length).toBe(2);
    expect(provider.isolationModes.map((m) => m.value)).toContain("worktree");
    expect(provider.isolationModes.map((m) => m.value)).toContain("inplace");
  });

  // ── Agent lifecycle through arkd ────────────────────────────────────────

  describe("agent lifecycle via arkd", () => {
    const TMUX_NAME = `local-wt-test-${Date.now()}`;

    afterAll(async () => {
      try {
        await client.killAgent({ sessionName: TMUX_NAME });
      } catch {
        /* cleanup */
      }
    });

    it("launch creates tmux session", async () => {
      const result = await provider.launch(compute, makeSession(), {
        tmuxName: TMUX_NAME,
        workdir: tempDir,
        launcherContent: "#!/bin/bash\nwhile true; do echo 'local-wt-running'; sleep 1; done",
        ports: [],
      });
      expect(result).toBe(TMUX_NAME);
      await waitFor(
        async () => {
          return await provider.checkSession(compute, TMUX_NAME);
        },
        { timeout: 5000 },
      );
    });

    it("checkSession returns true for running session", async () => {
      const exists = await provider.checkSession(compute, TMUX_NAME);
      expect(exists).toBe(true);
    });

    it("captureOutput returns content from tmux", async () => {
      await waitFor(
        async () => {
          const o = await provider.captureOutput(compute, makeSession(TMUX_NAME));
          return o.includes("local-wt-running");
        },
        { timeout: 5000 },
      );
      const output = await provider.captureOutput(compute, makeSession(TMUX_NAME));
      expect(output).toContain("local-wt-running");
    });

    it("killAgent stops the session", async () => {
      await provider.killAgent(compute, makeSession(TMUX_NAME));
      const exists = await provider.checkSession(compute, TMUX_NAME);
      expect(exists).toBe(false);
    });

    it("killAgent is noop for null session_id", async () => {
      await provider.killAgent(compute, makeSession()); // Should not throw
    });

    it("captureOutput returns empty for null session_id", async () => {
      const output = await provider.captureOutput(compute, makeSession());
      expect(output).toBe("");
    });
  });

  // ── Metrics via arkd ────────────────────────────────────────────────────

  describe("getMetrics via arkd", () => {
    it("returns full ComputeSnapshot", async () => {
      const snap = await provider.getMetrics(compute);
      expect(typeof snap.metrics.cpu).toBe("number");
      expect(snap.metrics.memTotalGb).toBeGreaterThan(0);
      expect(typeof snap.metrics.diskPct).toBe("number");
      expect(typeof snap.metrics.uptime).toBe("string");
      expect(Array.isArray(snap.sessions)).toBe(true);
      expect(Array.isArray(snap.processes)).toBe(true);
      expect(Array.isArray(snap.docker)).toBe(true);
    });
  });

  // ── Port probing via arkd ───────────────────────────────────────────────

  describe("probePorts via arkd", () => {
    it("detects arkd port and maps back PortDecl fields", async () => {
      const deadPort = await allocatePort(); // grab an ephemeral port, then let it close
      const results = await provider.probePorts(compute, [
        { port: ARKD_PORT, name: "arkd", source: "test" },
        { port: deadPort, name: "dead", source: "test" },
      ]);
      expect(results.length).toBe(2);

      const arkd = results.find((r) => r.port === ARKD_PORT);
      expect(arkd?.listening).toBe(true);
      expect(arkd?.name).toBe("arkd");
      expect(arkd?.source).toBe("test");

      const dead = results.find((r) => r.port === deadPort);
      expect(dead?.listening).toBe(false);
    });
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
    expect(provider.needsAuth).toBe(false);
  });

  it("getArkdUrl returns localhost:19300", () => {
    expect(provider.getArkdUrl(compute)).toBe("http://localhost:19300");
  });

  it("isolationModes includes container", () => {
    expect(provider.isolationModes[0].value).toBe("container");
  });

  it("launch writes script and creates docker-exec wrapper", async () => {
    const TMUX_NAME = `local-docker-test-${Date.now()}`;
    const dockerCompute = { ...compute, name: "test-docker-box", config: {} } as Compute;

    try {
      await provider.launch(dockerCompute, makeSession(), {
        tmuxName: TMUX_NAME,
        workdir: tempDir,
        launcherContent: "#!/bin/bash\necho hello-docker",
        ports: [],
      });

      await waitFor(
        () => {
          const scriptPath = `/tmp/arkd-launcher-${TMUX_NAME}.sh`;
          return existsSync(scriptPath);
        },
        { timeout: 5000 },
      );

      // The script on disk is the wrapper (agentLaunch overwrites the writeFile content)
      const scriptPath = `/tmp/arkd-launcher-${TMUX_NAME}.sh`;
      expect(existsSync(scriptPath)).toBe(true);
      const scriptContent = readFileSync(scriptPath, "utf-8");
      // Wrapper should contain docker exec into the container
      expect(scriptContent).toContain("docker exec");
      expect(scriptContent).toContain(scriptPath);

      // Verify tmux session was created (even though docker exec will fail - container doesn't exist)
      const status = await client.agentStatus({ sessionName: TMUX_NAME });
      expect(typeof status.running).toBe("boolean");
    } finally {
      try {
        await client.killAgent({ sessionName: TMUX_NAME });
      } catch {
        /* cleanup */
      }
    }
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

  it("launch writes script and creates devcontainer-exec wrapper", async () => {
    const TMUX_NAME = `local-dc-test-${Date.now()}`;
    const dcCompute = { ...compute, config: { workdir: tempDir } } as Compute;

    try {
      await provider.launch(dcCompute, makeSession(), {
        tmuxName: TMUX_NAME,
        workdir: tempDir,
        launcherContent: "#!/bin/bash\necho hello-devcontainer",
        ports: [],
      });

      await waitFor(
        () => {
          const scriptPath = `/tmp/arkd-launcher-${TMUX_NAME}.sh`;
          return existsSync(scriptPath);
        },
        { timeout: 5000 },
      );

      // The script on disk is the wrapper (agentLaunch overwrites the writeFile content)
      const scriptPath = `/tmp/arkd-launcher-${TMUX_NAME}.sh`;
      expect(existsSync(scriptPath)).toBe(true);
      const scriptContent = readFileSync(scriptPath, "utf-8");
      expect(scriptContent).toContain("devcontainer exec");
      expect(scriptContent).toContain(scriptPath);

      const status = await client.agentStatus({ sessionName: TMUX_NAME });
      expect(typeof status.running).toBe("boolean");
    } finally {
      try {
        await client.killAgent({ sessionName: TMUX_NAME });
      } catch {
        /* cleanup */
      }
    }
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

  it("provision fails on macOS with clear error", async () => {
    if (platform() === "darwin") {
      try {
        await provider.provision(compute);
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.message).toContain("Linux");
        expect(e.message).toContain("/dev/kvm");
      }
    }
  });

  it("launch writes script with ssh wrapper for microVM", async () => {
    const TMUX_NAME = `local-fc-test-${Date.now()}`;
    const fcCompute = { ...compute, config: { ssh_port: 2222 } } as Compute;

    try {
      await provider.launch(fcCompute, makeSession(), {
        tmuxName: TMUX_NAME,
        workdir: tempDir,
        launcherContent: "#!/bin/bash\necho hello-firecracker",
        ports: [],
      });

      await waitFor(
        () => {
          const scriptPath = `/tmp/arkd-launcher-${TMUX_NAME}.sh`;
          return existsSync(scriptPath);
        },
        { timeout: 5000 },
      );

      // The script on disk is the SSH wrapper (agentLaunch overwrites the writeFile content)
      const scriptPath = `/tmp/arkd-launcher-${TMUX_NAME}.sh`;
      expect(existsSync(scriptPath)).toBe(true);
      const scriptContent = readFileSync(scriptPath, "utf-8");
      expect(scriptContent).toContain("ssh");
      expect(scriptContent).toContain("2222");
      expect(scriptContent).toContain(scriptPath);

      const status = await client.agentStatus({ sessionName: TMUX_NAME });
      expect(typeof status.running).toBe("boolean");
    } finally {
      try {
        await client.killAgent({ sessionName: TMUX_NAME });
      } catch {
        /* cleanup */
      }
    }
  });
});
