/**
 * Tests for ArkdBackedProvider - verifies the base class correctly
 * delegates operations to an arkd instance.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startArkd } from "../../arkd/server.js";
import { ArkdBackedProvider } from "../providers/arkd-backed.js";
import type {
  Compute, Session, ProvisionOpts, SyncOpts, IsolationMode,
} from "../types.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

const TEST_PORT = 19360;
let server: { stop(): void };
let tempDir: string;

// Concrete test subclass - implements the abstract methods minimally
class TestArkdProvider extends ArkdBackedProvider {
  readonly name = "test-arkd";
  readonly isolationModes: IsolationMode[] = [];
  readonly canReboot = false;
  readonly canDelete = false;
  readonly supportsWorktree = false;
  readonly initialStatus = "running";
  readonly needsAuth = false;

  getArkdUrl(_compute: Compute): string {
    return `http://localhost:${TEST_PORT}`;
  }

  async provision() {}
  async destroy() {}
  async start() {}
  async stop() {}
  async attach() {}
  async cleanupSession() {}
  async syncEnvironment(_c: Compute, _o: SyncOpts) {}
  getAttachCommand() { return []; }
  buildChannelConfig() { return {}; }
  buildLaunchEnv() { return {}; }
}

const provider = new TestArkdProvider();

// Minimal Compute + Session objects for tests
const compute: Compute = {
  id: "test-compute",
  name: "test",
  provider: "test-arkd",
  status: "running",
  config: {},
} as Compute;

function makeSession(sessionId?: string): Session {
  return {
    id: "s-test-1",
    session_id: sessionId ?? null,
    workdir: tempDir,
    repo: tempDir,
  } as Session;
}

beforeAll(() => {
  tempDir = join(tmpdir(), `arkd-backed-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  server = startArkd(TEST_PORT, { quiet: true });
});

afterAll(() => {
  server.stop();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ── Launch + Kill + Status ──────────────────────────────────────────────────

describe("ArkdBackedProvider agent lifecycle", () => {
  const TMUX_NAME = `arkd-backed-test-${Date.now()}`;

  afterAll(async () => {
    try { await provider.killAgent(compute, makeSession(TMUX_NAME)); } catch {}
  });

  it("launch creates tmux session via arkd", async () => {
    const result = await provider.launch(compute, makeSession(), {
      tmuxName: TMUX_NAME,
      workdir: tempDir,
      launcherContent: "#!/bin/bash\nwhile true; do echo 'arkd-backed-running'; sleep 1; done",
      ports: [],
    });
    expect(result).toBe(TMUX_NAME);

    // Wait for tmux session to start
    await waitFor(async () => {
      return await provider.checkSession(compute, TMUX_NAME);
    }, { timeout: 5000 });
  });

  it("checkSession returns true for running session", async () => {
    const exists = await provider.checkSession(compute, TMUX_NAME);
    expect(exists).toBe(true);
  });

  it("checkSession returns false for nonexistent session", async () => {
    const exists = await provider.checkSession(compute, "arkd-nonexistent-xyz");
    expect(exists).toBe(false);
  });

  it("captureOutput returns tmux pane content", async () => {
    await waitFor(async () => {
      const o = await provider.captureOutput(compute, makeSession(TMUX_NAME));
      return o.includes("arkd-backed-running");
    }, { timeout: 5000 });
    const output = await provider.captureOutput(compute, makeSession(TMUX_NAME));
    expect(output).toContain("arkd-backed-running");
  });

  it("captureOutput returns empty for missing session_id", async () => {
    const output = await provider.captureOutput(compute, makeSession());
    expect(output).toBe("");
  });

  it("killAgent stops the tmux session", async () => {
    await provider.killAgent(compute, makeSession(TMUX_NAME));

    const exists = await provider.checkSession(compute, TMUX_NAME);
    expect(exists).toBe(false);
  });

  it("killAgent is a no-op when session_id is null", async () => {
    // Should not throw
    await provider.killAgent(compute, makeSession());
  });
});

// ── Metrics ─────────────────────────────────────────────────────────────────

describe("ArkdBackedProvider getMetrics", () => {
  it("returns ComputeSnapshot from arkd", async () => {
    const snap = await provider.getMetrics(compute);

    expect(typeof snap.metrics.cpu).toBe("number");
    expect(snap.metrics.memTotalGb).toBeGreaterThan(0);
    expect(typeof snap.metrics.memPct).toBe("number");
    expect(typeof snap.metrics.diskPct).toBe("number");
    expect(typeof snap.metrics.uptime).toBe("string");

    expect(Array.isArray(snap.sessions)).toBe(true);
    expect(Array.isArray(snap.processes)).toBe(true);
    expect(Array.isArray(snap.docker)).toBe(true);
  });
});

// ── Port probing ────────────────────────────────────────────────────────────

describe("ArkdBackedProvider probePorts", () => {
  it("probes ports and maps back to PortDecl", async () => {
    const ports = [
      { port: TEST_PORT, name: "arkd", source: "test" },
      { port: 19999, name: "dead", source: "test" },
    ];
    const results = await provider.probePorts(compute, ports);

    expect(results.length).toBe(2);

    const arkd = results.find(r => r.port === TEST_PORT);
    expect(arkd?.listening).toBe(true);
    expect(arkd?.name).toBe("arkd");
    expect(arkd?.source).toBe("test");

    const dead = results.find(r => r.port === 19999);
    expect(dead?.listening).toBe(false);
  });
});
