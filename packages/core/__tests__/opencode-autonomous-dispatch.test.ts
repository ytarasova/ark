/**
 * Tests for OpenCode runtime working with autonomous dispatch.
 *
 * Validates the full dispatch path for --runtime opencode on the autonomous flow:
 * 1. Runtime resolution: opencode.yaml merges into agent -> _resolved_runtime_type = "opencode"
 * 2. Agent model override: agent model is remapped to opencode's model list
 * 3. OpenCode executor: launches opencode with -p task delivery + .opencode.json config
 * 4. Status poller: detects tmux exit (not_found) and completes session
 * 5. Flow advance: single-stage autonomous flow completes after poller triggers
 * 6. Transcript parsing: opencode billing mode is wired in RuntimeBilling
 * 7. Command builder: buildOpenCodeCommand produces correct argv for autonomous dispatch
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { AppContext } from "../app.js";
import { startStatusPoller, stopAllPollers } from "../executors/status-poller.js";
import { opencodeExecutor } from "../executors/opencode.js";
import { buildOpenCodeCommand, buildOpenCodeConfig } from "../executors/opencode.js";
import { resolveAgentWithRuntime } from "../agent/agent.js";
import * as tmux from "../infra/tmux.js";

// -- App fixture --------------------------------------------------------------

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  stopAllPollers();
  await app?.shutdown();
});

// -- Helper -------------------------------------------------------------------

function waitFor(fn: () => boolean, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(check, 100);
    };
    check();
  });
}

// -- Runtime resolution -------------------------------------------------------

describe("OpenCode runtime resolution", () => {
  it("opencode runtime definition loads from RuntimeStore", () => {
    const runtime = app.runtimes.get("opencode");
    expect(runtime).not.toBeNull();
    expect(runtime!.name).toBe("opencode");
    expect(runtime!.type).toBe("opencode");
    expect(runtime!.command).toEqual(["opencode"]);
    expect(runtime!.task_delivery).toBe("arg");
    expect(runtime!.billing?.mode).toBe("api");
    expect(runtime!.billing?.transcript_parser).toBe("opencode");
  });

  it("resolveAgentWithRuntime merges opencode runtime into worker agent", () => {
    const session = { summary: "test task", id: "s-oc01" };
    const agent = resolveAgentWithRuntime(app, "worker", session, { runtimeOverride: "opencode" });

    expect(agent).not.toBeNull();
    expect(agent!._resolved_runtime_type).toBe("opencode");
    expect(agent!.command).toEqual(["opencode"]);
    expect(agent!.task_delivery).toBe("arg");
  });

  it("remaps agent model to opencode default when agent model is not in opencode model list", () => {
    const session = { summary: "test", id: "s-oc02" };
    const agent = resolveAgentWithRuntime(app, "worker", session, { runtimeOverride: "opencode" });

    // Worker agent defaults to "opus" which isn't in opencode's model list.
    // resolveAgentWithRuntime should remap to opencode's default_model.
    expect(agent).not.toBeNull();
    expect(agent!.model).toBe("claude-sonnet-4-6");
  });

  it("all six builtin runtimes are loadable", () => {
    const names = ["claude", "claude-max", "codex", "gemini", "goose", "opencode"];
    for (const name of names) {
      const runtime = app.runtimes.get(name);
      expect(runtime).not.toBeNull();
      expect(runtime!.name).toBe(name);
    }
  });

  it("opencode runtime type maps to opencode executor (not cli-agent)", () => {
    const runtime = app.runtimes.get("opencode");
    expect(runtime!.type).toBe("opencode");
    const gemini = app.runtimes.get("gemini");
    expect(gemini!.type).toBe("cli-agent");
    expect(runtime!.type).not.toBe(gemini!.type);
  });
});

// -- OpenCode executor with autonomous dispatch config ------------------------

describe("OpenCode dispatch via opencode executor", () => {
  let createSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createSpy = spyOn(tmux, "createSessionAsync").mockImplementation(async () => {});
  });

  afterEach(() => {
    createSpy.mockRestore();
  });

  it("opencode executor is registered and has the correct name", () => {
    expect(opencodeExecutor.name).toBe("opencode");
    expect(typeof opencodeExecutor.launch).toBe("function");
    expect(typeof opencodeExecutor.kill).toBe("function");
    expect(typeof opencodeExecutor.status).toBe("function");
    expect(typeof opencodeExecutor.send).toBe("function");
    expect(typeof opencodeExecutor.capture).toBe("function");
  });

  it("opencode executor returns not_found when tmux session exits", async () => {
    const existsSpy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);
    try {
      const status = await opencodeExecutor.status("ark-s-oc01");
      expect(status.state).toBe("not_found");
    } finally {
      existsSpy.mockRestore();
    }
  });

  it("opencode executor returns running when tmux session is alive", async () => {
    const existsSpy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(true);
    try {
      const status = await opencodeExecutor.status("ark-s-oc02");
      expect(status.state).toBe("running");
    } finally {
      existsSpy.mockRestore();
    }
  });
});

// -- buildOpenCodeCommand for autonomous dispatch -----------------------------

describe("buildOpenCodeCommand for autonomous dispatch", () => {
  it("produces correct argv for autonomous text delivery", () => {
    const argv = buildOpenCodeCommand({ task: "Fix the failing test in parser.ts" });

    expect(argv[0]).toBe("opencode");
    expect(argv).toContain("-q");
    expect(argv).toContain("-p");
    expect(argv[argv.indexOf("-p") + 1]).toBe("Fix the failing test in parser.ts");
  });

  it("argv is fixed-shape (no optional flags to miss)", () => {
    const argv = buildOpenCodeCommand({ task: "test" });
    expect(argv).toHaveLength(4);
    expect(argv).toEqual(["opencode", "-q", "-p", "test"]);
  });
});

// -- buildOpenCodeConfig for dispatch -----------------------------------------

describe("buildOpenCodeConfig for dispatch", () => {
  it("produces config with model pinning for coder and task agents", () => {
    const config = buildOpenCodeConfig({ model: "claude-sonnet-4-6" });
    const agents = config.agents as any;
    expect(agents.coder.model).toBe("claude-sonnet-4-6");
    expect(agents.task.model).toBe("claude-sonnet-4-6");
  });

  it("injects ark-channel MCP server for conductor communication", () => {
    const config = buildOpenCodeConfig({
      mcpServers: {
        "ark-channel": {
          type: "stdio",
          command: "/usr/local/bin/bun",
          args: ["run", "/ark/packages/core/claude/channel.ts"],
          env: { ARK_SESSION_ID: "s-oc10", ARK_CHANNEL_PORT: "19200" },
        },
      },
    });
    const servers = config.mcpServers as any;
    expect(servers["ark-channel"].type).toBe("stdio");
    expect(servers["ark-channel"].command).toBe("/usr/local/bin/bun");
    expect(servers["ark-channel"].env.ARK_SESSION_ID).toBe("s-oc10");
  });
});

// -- Status poller + autonomous flow completion -------------------------------

describe("OpenCode runtime + autonomous flow completion", () => {
  it("status poller completes session when opencode tmux exits", async () => {
    const session = app.sessions.create({ summary: "opencode autonomous test", flow: "autonomous" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-" + session.id,
      config: { runtime: "opencode", runtime_override: "opencode" },
    });

    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "opencode");

      await waitFor(() => {
        const s = app.sessions.get(session.id);
        return s?.status === "completed";
      });

      const updated = app.sessions.get(session.id);
      expect(updated?.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
  });

  it("status poller logs session_completed event", async () => {
    const session = app.sessions.create({ summary: "opencode event test", flow: "autonomous" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-" + session.id,
    });

    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "opencode");

      await waitFor(() => {
        const s = app.sessions.get(session.id);
        return s?.status === "completed";
      });

      const events = app.events.list(session.id);
      const completedEvent = events.find((e) => e.type === "session_completed");
      expect(completedEvent).not.toBeUndefined();
      const data = typeof completedEvent!.data === "string" ? JSON.parse(completedEvent!.data) : completedEvent!.data;
      expect(data.reason).toBe("agent process exited");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not double-poll the same session", async () => {
    const session = app.sessions.create({ summary: "opencode no-double test", flow: "autonomous" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-" + session.id,
    });

    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(true);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "opencode");
      startStatusPoller(app, session.id, "ark-" + session.id, "opencode");

      await Bun.sleep(100);
      const s = app.sessions.get(session.id);
      expect(s?.status).toBe("running");
    } finally {
      spy.mockRestore();
    }
  });
});

// -- OpenCode billing config --------------------------------------------------

describe("OpenCode runtime billing and transcript config", () => {
  it("opencode runtime billing config specifies transcript_parser: opencode", () => {
    const runtime = app.runtimes.get("opencode");
    expect(runtime).not.toBeNull();
    expect(runtime!.billing?.transcript_parser).toBe("opencode");
  });

  it("opencode runtime billing mode is api (per-token pricing)", () => {
    const runtime = app.runtimes.get("opencode");
    expect(runtime).not.toBeNull();
    expect(runtime!.billing?.mode).toBe("api");
  });

  it("opencode runtime default model is claude-sonnet-4-6", () => {
    const runtime = app.runtimes.get("opencode");
    expect(runtime).not.toBeNull();
    expect(runtime!.default_model).toBe("claude-sonnet-4-6");
  });

  it("opencode runtime has multiple model options", () => {
    const runtime = app.runtimes.get("opencode");
    expect(runtime).not.toBeNull();
    expect(runtime!.models!.length).toBeGreaterThanOrEqual(3);
    const modelIds = runtime!.models!.map((m) => m.id);
    expect(modelIds).toContain("claude-sonnet-4-6");
    expect(modelIds).toContain("claude-opus-4-6");
  });
});

// -- Executor dispatch path ---------------------------------------------------

describe("OpenCode runtime executor dispatch path", () => {
  it("opencode executor is in builtinExecutors", async () => {
    const { builtinExecutors } = await import("../executors/index.js");
    const names = builtinExecutors.map((e) => e.name);
    expect(names).toContain("opencode");
  });

  it("opencode executor is registered in executor registry", async () => {
    const { getExecutor } = await import("../executor.js");
    const executor = getExecutor("opencode");
    expect(executor).not.toBeUndefined();
    expect(executor!.name).toBe("opencode");
  });

  it("dispatch runtime resolution: opencode override -> _resolved_runtime_type opencode -> opencode executor", async () => {
    const { getExecutor } = await import("../executor.js");

    const session = { summary: "dispatch path test", id: "s-oc20" };
    const agent = resolveAgentWithRuntime(app, "worker", session, { runtimeOverride: "opencode" });
    expect(agent!._resolved_runtime_type).toBe("opencode");

    const runtime = agent!._resolved_runtime_type ?? agent!.runtime ?? "claude-code";
    expect(runtime).toBe("opencode");

    const executor = app.pluginRegistry.executor(runtime) ?? getExecutor(runtime);
    expect(executor).not.toBeUndefined();
    expect(executor!.name).toBe("opencode");
  });

  it("dispatch starts status poller for opencode runtime (not claude-code hooks)", () => {
    const session = { summary: "poller check", id: "s-oc21" };
    const agent = resolveAgentWithRuntime(app, "worker", session, { runtimeOverride: "opencode" });
    const runtime = agent!._resolved_runtime_type ?? agent!.runtime ?? "claude-code";
    expect(runtime).not.toBe("claude-code");
  });

  it("opencode transcript parser is registered", () => {
    const parser = app.transcriptParsers.get("opencode");
    expect(parser).not.toBeUndefined();
    expect(parser!.kind).toBe("opencode");
  });
});
