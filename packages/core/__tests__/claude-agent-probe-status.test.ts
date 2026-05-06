/**
 * claude-agent's runtime-aware status probe (#435).
 *
 * The status-poller calls executor.probeStatus instead of
 * provider.checkSession when the executor implements it. claude-agent
 * spawns its agent as a Bun process via arkd /process/spawn, NOT tmux,
 * so the tmux-based /agent/status (the default checkSession query)
 * always returns false for it. Without this polymorphic probe the
 * poller flips the row to "completed" within ~3s of launch, kicks
 * the action chain prematurely, and leaves the session in an
 * inconsistent state when the actually-still-running agent later
 * emits SessionEnd.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { claudeAgentExecutor } from "../executors/claude-agent.js";
import type { Compute } from "../../types/index.js";
import type { ComputeProvider } from "../compute/legacy-provider.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
});

function makeProvider(overrides: Partial<ComputeProvider>): ComputeProvider {
  return {
    name: "test",
    singleton: false,
    canReboot: false,
    canDelete: false,
    supportsWorktree: false,
    supportsSecretMount: false,
    initialStatus: "ready",
    needsAuth: false,
    ...overrides,
  } as ComputeProvider;
}

const dummyCompute: Compute = {
  name: "test-compute",
  provider: "test",
  status: "ready",
} as Compute;

describe("claude-agent.probeStatus (#435)", () => {
  it("reports running when arkd /process/status says the PID is alive", async () => {
    const session = await app.sessions.create({ summary: "probe running", flow: "quick" });

    const provider = makeProvider({
      statusProcessByHandle: async () => ({ running: true, pid: 12345 }),
    });

    const result = await claudeAgentExecutor.probeStatus!({
      app,
      session,
      handle: `ark-${session.id}`,
      compute: dummyCompute,
      provider,
    });

    expect(result.state).toBe("running");
  });

  it("reports completed when the process exited with code 0", async () => {
    const session = await app.sessions.create({ summary: "probe completed", flow: "quick" });

    const provider = makeProvider({
      statusProcessByHandle: async () => ({ running: false, exitCode: 0 }),
    });

    const result = await claudeAgentExecutor.probeStatus!({
      app,
      session,
      handle: `ark-${session.id}`,
      compute: dummyCompute,
      provider,
    });

    expect(result.state).toBe("completed");
    expect((result as { exitCode?: number }).exitCode).toBe(0);
  });

  it("reports failed when the process exited with a non-zero code", async () => {
    const session = await app.sessions.create({ summary: "probe failed", flow: "quick" });

    const provider = makeProvider({
      statusProcessByHandle: async () => ({ running: false, exitCode: 137 }),
    });

    const result = await claudeAgentExecutor.probeStatus!({
      app,
      session,
      handle: `ark-${session.id}`,
      compute: dummyCompute,
      provider,
    });

    expect(result.state).toBe("failed");
    expect((result as { error?: string }).error).toContain("137");
  });

  it("reports not_found when arkd has no record of the handle (no exitCode)", async () => {
    // This is what arkd returns after a daemon restart: the in-memory
    // process map is empty, so the handle lookup misses entirely.
    const session = await app.sessions.create({ summary: "probe not_found", flow: "quick" });

    const provider = makeProvider({
      statusProcessByHandle: async () => ({ running: false }),
    });

    const result = await claudeAgentExecutor.probeStatus!({
      app,
      session,
      handle: `ark-${session.id}`,
      compute: dummyCompute,
      provider,
    });

    expect(result.state).toBe("not_found");
  });

  it("does NOT consult the tmux probe (provider.checkSession) -- regression for #435", async () => {
    // The whole point of the executor-owned probe is that claude-agent
    // never asks /agent/status (tmux). If the implementation slipped
    // back to checkSession, this test would flip to "not_found"
    // because checkSession returns false for a process-based handle.
    const session = await app.sessions.create({ summary: "no-tmux-probe", flow: "quick" });

    let checkSessionCalled = false;
    const provider = makeProvider({
      checkSession: async () => {
        checkSessionCalled = true;
        return false;
      },
      statusProcessByHandle: async () => ({ running: true, pid: 999 }),
    });

    const result = await claudeAgentExecutor.probeStatus!({
      app,
      session,
      handle: `ark-${session.id}`,
      compute: dummyCompute,
      provider,
    });

    expect(checkSessionCalled).toBe(false);
    expect(result.state).toBe("running");
  });

  it("falls back to running when the provider has no statusProcessByHandle", async () => {
    // A misconfigured provider must NOT cause a false-positive completion.
    // The poller treats "running" as "keep waiting" so a missing capability
    // is safer than synthesizing not_found.
    const session = await app.sessions.create({ summary: "no-status-cap", flow: "quick" });

    const provider = makeProvider({});

    const result = await claudeAgentExecutor.probeStatus!({
      app,
      session,
      handle: `ark-${session.id}`,
      compute: dummyCompute,
      provider,
    });

    expect(result.state).toBe("running");
  });
});
