/**
 * Tests for the claude-agent executor dispatch path.
 *
 * Validates:
 *  1. claude-agent runtime definition loads from RuntimeStore
 *  2. resolveAgentWithRuntime merges claude-agent runtime into worker agent
 *  3. claudeAgentExecutor is registered with the correct interface
 *  4. Executor dispatch assembles ARK_* env vars and spawns without tmux
 *  5. kill() sends SIGTERM to the tracked process
 *  6. status() reflects process state
 *
 * All tests that touch the executor itself use a mock Bun.spawn so no real
 * claude-agent process is started -- tests run without ANTHROPIC_API_KEY.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { join } from "path";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { AppContext } from "../app.js";
import { resolveAgentWithRuntime } from "../agent/agent.js";
import { claudeAgentExecutor } from "../executors/claude-agent.js";
import { stopAllPollers } from "../executors/status-poller.js";

// ── App fixture ──────────────────────────────────────────────────────────────

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  if (app) stopAllPollers(app);
  await app?.shutdown();
});

// ── Runtime resolution ───────────────────────────────────────────────────────

describe("claude-agent runtime resolution", () => {
  it("claude-agent runtime definition loads from RuntimeStore", () => {
    const runtime = app.runtimes.get("claude-agent");
    expect(runtime).not.toBeNull();
    expect(runtime!.name).toBe("claude-agent");
    expect(runtime!.type).toBe("claude-agent");
    expect(Array.isArray(runtime!.secrets)).toBe(true);
    expect(runtime!.secrets).toContain("ANTHROPIC_API_KEY");
    expect(runtime!.billing?.mode).toBe("api");
    // transcript_parser is a separate identifier from the runtime name and was
    // intentionally left as `agent-sdk` -- it pairs with AgentSdkParser.kind.
    expect(runtime!.billing?.transcript_parser).toBe("agent-sdk");
  });

  it("resolveAgentWithRuntime merges claude-agent runtime into worker agent", () => {
    const session = { summary: "test task", id: "s-sdk01" };
    const agent = resolveAgentWithRuntime(app, "worker", session, { runtimeOverride: "claude-agent" });

    expect(agent).not.toBeNull();
    expect(agent!._resolved_runtime_type).toBe("claude-agent");
  });

  it("all six builtin runtimes are loadable including claude-agent", () => {
    const names = ["claude-code", "claude-max", "codex", "gemini", "goose", "claude-agent"];
    for (const name of names) {
      const runtime = app.runtimes.get(name);
      expect(runtime).not.toBeNull();
      expect(runtime!.name).toBe(name);
    }
  });

  it("claude-agent runtime type maps to claude-agent executor (not cli-agent)", () => {
    const runtime = app.runtimes.get("claude-agent");
    expect(runtime!.type).toBe("claude-agent");
    // Verify this is distinct from gemini which uses cli-agent
    const gemini = app.runtimes.get("gemini");
    expect(gemini!.type).toBe("cli-agent");
    expect(runtime!.type).not.toBe(gemini!.type);
  });

  // ── Backward-compat alias for the May 2026 runtime rename ─────────────────
  it("legacy runtime name `agent-sdk` resolves to claude-agent via alias", () => {
    const aliased = app.runtimes.get("agent-sdk");
    const canonical = app.runtimes.get("claude-agent");
    expect(aliased).not.toBeNull();
    expect(canonical).not.toBeNull();
    expect(aliased!.name).toBe(canonical!.name);
    expect(aliased!.type).toBe(canonical!.type);
  });

  it("legacy runtime name `claude` resolves to claude-code via alias", () => {
    const aliased = app.runtimes.get("claude");
    const canonical = app.runtimes.get("claude-code");
    expect(aliased).not.toBeNull();
    expect(canonical).not.toBeNull();
    expect(aliased!.name).toBe(canonical!.name);
    expect(aliased!.type).toBe(canonical!.type);
  });
});

// ── Executor interface ────────────────────────────────────────────────────────

describe("claudeAgentExecutor interface", () => {
  it("executor is registered with the correct name", () => {
    expect(claudeAgentExecutor.name).toBe("claude-agent");
    expect(typeof claudeAgentExecutor.launch).toBe("function");
    expect(typeof claudeAgentExecutor.kill).toBe("function");
    expect(typeof claudeAgentExecutor.status).toBe("function");
    expect(typeof claudeAgentExecutor.send).toBe("function");
    expect(typeof claudeAgentExecutor.capture).toBe("function");
  });

  it("status returns not_found for an unknown handle", async () => {
    const status = await claudeAgentExecutor.status("sdk-does-not-exist");
    expect(status.state).toBe("not_found");
  });

  it("kill is a no-op for an unknown handle", async () => {
    // Should not throw
    await claudeAgentExecutor.kill("sdk-does-not-exist");
  });

  it("capture returns empty string for unknown handle (no tracked entry)", async () => {
    const out = await claudeAgentExecutor.capture("sdk-does-not-exist", 20);
    expect(out).toBe("");
  });
});

// ── capture(): reads transcript.jsonl + stdio.log when process is tracked ────

describe("claudeAgentExecutor.capture -- from tracked entry", () => {
  /**
   * We exercise capture() by launching with a mock spawn (so the TrackedSdkProcess
   * entry is registered in the module-level map) and then writing transcript.jsonl
   * and stdio.log into the resulting sessionDir before calling capture().
   */
  function makeFakeProc(exitCode = 0) {
    const exited = Promise.resolve(exitCode);
    return {
      pid: 88888,
      exitCode,
      stdout: null,
      stderr: null,
      exited,
      kill: mock(() => {}),
    } as unknown as ReturnType<typeof Bun.spawn>;
  }

  it("returns formatted transcript lines + stdio section", async () => {
    const session = await app.sessions.create({
      summary: "capture test",
      workdir: app.config.dirs.ark,
      flow: "autonomous-sdlc",
    });

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_opts: any) => makeFakeProc(0));

    try {
      const agent = {
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

      const result = await claudeAgentExecutor.launch({
        sessionId: session.id,
        workdir: app.config.dirs.ark,
        agent,
        task: "capture test task",
        env: { ANTHROPIC_API_KEY: "test" },
        onLog: () => {},
        app,
      });

      expect(result.ok).toBe(true);
      const handle = result.handle;

      // Write synthetic transcript.jsonl and stdio.log into the session dir
      const sessionDir = join(app.config.dirs.tracks, session.id);
      mkdirSync(sessionDir, { recursive: true });

      const transcriptLines = [
        JSON.stringify({ type: "system", subtype: "init", cwd: "/repo", model: "claude-sonnet-4-6", tools: ["Read"] }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.0042,
          num_turns: 2,
          duration_ms: 6000,
        }),
      ];
      writeFileSync(join(sessionDir, "transcript.jsonl"), transcriptLines.join("\n") + "\n");
      writeFileSync(join(sessionDir, "stdio.log"), "[exec 2026-04-22T19:51:00Z] claude-agent compat modes: (none)\n");

      const output = await claudeAgentExecutor.capture(handle, 80);

      // Transcript lines should be formatted
      expect(output).toContain("system/init");
      expect(output).toContain("claude-sonnet-4-6");
      expect(output).toContain("result/success");
      expect(output).toContain("$0.0042");
      // Stdio section should appear
      expect(output).toContain("--- stdio ---");
      expect(output).toContain("claude-agent compat modes");
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

// ── Dispatch: spawns without tmux ────────────────────────────────────────────

describe("claudeAgentExecutor.launch -- spawn mechanics", () => {
  /**
   * Build a minimal fake Bun subprocess that reports as "exited" immediately.
   * This lets launch() complete without actually running the agent.
   */
  function makeFakeProc(exitCode = 0) {
    const exited = Promise.resolve(exitCode);
    return {
      pid: 99999,
      exitCode,
      stdout: null,
      stderr: null,
      exited,
      kill: mock(() => {}),
    } as unknown as ReturnType<typeof Bun.spawn>;
  }

  it("spawns a process (not a tmux session) and returns a sdk- handle", async () => {
    const session = await app.sessions.create({
      summary: "test dispatch",
      workdir: app.config.dirs.ark,
      flow: "autonomous-sdlc",
    });

    let spawnCalled = false;
    let capturedCmd: string[] = [];
    let capturedEnv: Record<string, string> = {};

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((opts: any) => {
      spawnCalled = true;
      capturedCmd = Array.isArray(opts) ? opts : (opts.cmd ?? []);
      capturedEnv = opts.env ?? {};
      return makeFakeProc(0);
    });

    try {
      const agent = {
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

      const result = await claudeAgentExecutor.launch({
        sessionId: session.id,
        workdir: app.config.dirs.ark,
        agent,
        task: "do something useful",
        env: { ANTHROPIC_API_KEY: "test-key" },
        onLog: () => {},
        app,
      });

      expect(result.ok).toBe(true);
      expect(result.handle).toBe(`sdk-${session.id}`);
      expect(result.pid).toBe(99999);
      expect(spawnCalled).toBe(true);

      // No tmux session created
      const { execFileSync } = await import("child_process");
      let tmuxExists = false;
      try {
        execFileSync("tmux", ["has-session", "-t", `ark-${session.id}`], { stdio: "pipe" });
        tmuxExists = true;
      } catch {
        tmuxExists = false;
      }
      expect(tmuxExists).toBe(false);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it("assembles ARK_* env vars correctly", async () => {
    const session = await app.sessions.create({
      summary: "env var test",
      workdir: app.config.dirs.ark,
      flow: "autonomous-sdlc",
    });

    let capturedEnv: Record<string, string> = {};

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((opts: any) => {
      capturedEnv = opts.env ?? {};
      return makeFakeProc(0);
    });

    try {
      const agent = {
        name: "worker",
        model: "claude-sonnet-4-6",
        max_turns: 50,
        system_prompt: "",
        tools: [],
        skills: [],
        mcp_servers: [],
        permission_mode: "bypassPermissions",
        env: {},
        runtime: "claude-agent",
        _resolved_runtime_type: "claude-agent",
      };

      await claudeAgentExecutor.launch({
        sessionId: session.id,
        workdir: app.config.dirs.ark,
        agent,
        task: "write tests",
        env: { ANTHROPIC_API_KEY: "sk-test-abc" },
        onLog: () => {},
        app,
      });

      // Required ARK_* env vars
      expect(capturedEnv.ARK_SESSION_ID).toBe(session.id);
      expect(capturedEnv.ARK_SESSION_DIR).toContain(session.id);
      expect(capturedEnv.ARK_CONDUCTOR_URL).toBeTruthy();
      expect(capturedEnv.ARK_PROMPT_FILE).toContain("task.txt");

      // Secret from opts.env propagated
      expect(capturedEnv.ANTHROPIC_API_KEY).toBe("sk-test-abc");

      // Model from agent config
      expect(capturedEnv.ARK_MODEL).toBe("claude-sonnet-4-6");

      // max_turns propagated
      expect(capturedEnv.ARK_MAX_TURNS).toBe("50");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it("writes task.txt (prompt file) to sessionDir before spawning", async () => {
    const session = await app.sessions.create({
      summary: "prompt file test",
      workdir: app.config.dirs.ark,
      flow: "autonomous-sdlc",
    });

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_opts: any) => makeFakeProc(0));

    try {
      const agent = {
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

      const task = "implement the feature described in issue #42";

      await claudeAgentExecutor.launch({
        sessionId: session.id,
        workdir: app.config.dirs.ark,
        agent,
        task,
        env: { ANTHROPIC_API_KEY: "test" },
        onLog: () => {},
        app,
      });

      const promptPath = join(app.config.dirs.tracks, session.id, "task.txt");
      expect(existsSync(promptPath)).toBe(true);

      const { readFileSync } = await import("fs");
      const content = readFileSync(promptPath, "utf8");
      expect(content).toBe(task);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it("status reflects running state while process is alive", async () => {
    const session = await app.sessions.create({
      summary: "status test",
      workdir: app.config.dirs.ark,
      flow: "autonomous-sdlc",
    });

    // Create a proc that never exits during the test
    let resolveExit: (code: number) => void;
    const exitedPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const fakeProc = {
      pid: 12345,
      exitCode: null,
      stdout: null,
      stderr: null,
      exited: exitedPromise,
      kill: mock(() => {
        resolveExit!(0);
      }),
    } as unknown as ReturnType<typeof Bun.spawn>;

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_opts: any) => fakeProc);

    try {
      const agent = {
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

      const result = await claudeAgentExecutor.launch({
        sessionId: session.id,
        workdir: app.config.dirs.ark,
        agent,
        task: "check status",
        env: { ANTHROPIC_API_KEY: "test" },
        onLog: () => {},
        app,
      });

      expect(result.ok).toBe(true);
      const handle = result.handle;

      const status = await claudeAgentExecutor.status(handle);
      expect(status.state).toBe("running");
      expect((status as { state: string; pid?: number }).pid).toBe(12345);

      // Kill cleans up
      await claudeAgentExecutor.kill(handle);
      // Process should now be gone or killed
      await exitedPromise; // wait for exited to resolve
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

// ── executor registered in builtinExecutors ───────────────────────────────────

describe("claudeAgentExecutor registration", () => {
  it("is included in builtinExecutors", async () => {
    const { builtinExecutors } = await import("../executors/index.js");
    const found = builtinExecutors.find((e) => e.name === "claude-agent");
    expect(found).not.toBeUndefined();
    expect(found!.name).toBe("claude-agent");
  });

  it("getExecutor resolves the legacy `agent-sdk` name via alias", async () => {
    const { getExecutor } = await import("../executor.js");
    const aliased = getExecutor("agent-sdk");
    const canonical = getExecutor("claude-agent");
    expect(canonical).not.toBeUndefined();
    expect(aliased).toBe(canonical);
  });
});
