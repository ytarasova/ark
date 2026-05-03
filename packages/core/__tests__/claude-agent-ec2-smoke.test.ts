/**
 * Smoke test: claude-agent runtime + EC2 compute.
 *
 * Context: the May 2026 commit 546fdc0c flipped every builtin agent
 * (worker, planner, implementer, ...) from `runtime: claude-code` to
 * `runtime: claude-agent`. The claude-agent executor is local-mode only --
 * it runs the Anthropic Agent SDK inside the conductor's own process and
 * writes transcript.jsonl / stdio.log to the conductor's local filesystem.
 * It has no path to ship itself onto an EC2 VM.
 *
 * Before the guard: pairing `runtime: claude-agent` with a session whose
 * `compute_name` pointed at an EC2 row would silently fall through to a
 * local Bun.spawn on the conductor. setupSessionWorktree sees
 * `provider.supportsWorktree === false` (EC2 is a remote-arkd provider) and
 * skips the worktree step; the executor then spawns against the local
 * repo path. The operator thinks they have a remote session but they
 * don't -- the agent is editing the conductor's checkout, the EC2
 * instance is idle, and concurrent dispatches collide on the local
 * workdir.
 *
 * This test locks in the explicit refusal. If a future change re-enables
 * claude-agent on remote compute (running the SDK on the worker), delete
 * or invert this test with a reference to the issue that landed remote
 * support.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { AppContext } from "../app.js";
import { claudeAgentExecutor } from "../executors/claude-agent.js";
import { stopAllPollers } from "../executors/status-poller.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  if (app) stopAllPollers(app);
  await app?.shutdown();
});

function makeAgent() {
  return {
    name: "worker",
    model: "claude-sonnet-4-6",
    max_turns: 10,
    system_prompt: "",
    tools: [],
    skills: [],
    mcp_servers: [],
    permission_mode: "bypassPermissions",
    env: {},
    runtime: "claude-agent",
    _resolved_runtime_type: "claude-agent",
  };
}

describe("claude-agent on EC2 (smoke)", () => {
  it("refuses to launch when the session's compute_kind is 'ec2'", async () => {
    // Seed an EC2 compute row so resolveProvider returns compute_kind='ec2'.
    await app.computeService.create({
      name: "ec2-prod",
      provider: "ec2" as any,
      compute: "ec2" as any,
      config: {},
    });

    const session = await app.sessions.create({
      summary: "ec2 smoke",
      workdir: app.config.dirs.ark,
      flow: "autonomous-sdlc",
    });
    await app.sessions.update(session.id, { compute_name: "ec2-prod" });

    // Bun.spawn should never be called -- the guard rejects before spawn.
    const spawnSpy = spyOn(Bun, "spawn");
    try {
      const result = await claudeAgentExecutor.launch({
        sessionId: session.id,
        workdir: app.config.dirs.ark,
        agent: makeAgent(),
        task: "does not matter -- guard should fire first",
        env: { ANTHROPIC_API_KEY: "sk-test" },
        onLog: () => {},
        app,
      });

      expect(result.ok).toBe(false);
      expect(result.handle).toBe("");
      expect(result.message).toContain("claude-agent");
      expect(result.message).toContain("ec2");
      expect(result.message).toContain("runtime: claude-code");
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it("refuses to launch for EC2 docker isolation (compute_kind still 'ec2')", async () => {
    // The legacy `provider` column distinguishes ec2 vs ec2-docker vs
    // ec2-devcontainer -- all three share compute_kind='ec2'. The guard
    // is keyed on compute_kind, so every ec2-* variant must be rejected
    // regardless of isolation.
    await app.computeService.create({
      name: "ec2-dc",
      provider: "ec2-docker" as any,
      compute: "ec2" as any,
      config: {},
    });

    const session = await app.sessions.create({
      summary: "ec2-docker smoke",
      workdir: app.config.dirs.ark,
      flow: "autonomous-sdlc",
    });
    await app.sessions.update(session.id, { compute_name: "ec2-dc" });

    const result = await claudeAgentExecutor.launch({
      sessionId: session.id,
      workdir: app.config.dirs.ark,
      agent: makeAgent(),
      task: "smoke",
      env: { ANTHROPIC_API_KEY: "sk-test" },
      onLog: () => {},
      app,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ec2");
    expect(result.message).toContain("runtime: claude-code");
  });

  it("permits launch when the session's compute_kind is 'local' (baseline)", async () => {
    // Sanity check that the guard only blocks non-local kinds. Local mode
    // seeds a `local` compute row at boot, so a session without an
    // explicit compute_name resolves to it via the AppMode default.
    const session = await app.sessions.create({
      summary: "local baseline",
      workdir: app.config.dirs.ark,
      flow: "autonomous-sdlc",
    });

    // Mock Bun.spawn so the in-process SDK launch path succeeds without a
    // real claude-agent binary (no ANTHROPIC_API_KEY required).
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(
      (_opts: any) =>
        ({
          pid: 77777,
          exitCode: 0,
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          kill: () => {},
        }) as unknown as ReturnType<typeof Bun.spawn>,
    );

    try {
      const result = await claudeAgentExecutor.launch({
        sessionId: session.id,
        workdir: app.config.dirs.ark,
        agent: makeAgent(),
        task: "local baseline task",
        env: { ANTHROPIC_API_KEY: "sk-test" },
        onLog: () => {},
        app,
      });

      expect(result.ok).toBe(true);
      expect(result.handle).toBe(`sdk-${session.id}`);
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
