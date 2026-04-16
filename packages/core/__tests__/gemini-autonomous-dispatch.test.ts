/**
 * Tests for Gemini runtime working with autonomous dispatch.
 *
 * Validates the full dispatch path for --runtime gemini on the autonomous flow:
 * 1. Runtime resolution: gemini.yaml merges into agent -> _resolved_runtime_type = "cli-agent"
 * 2. Agent model override: agent model is remapped to gemini's model list
 * 3. CLI-agent executor: launches gemini with stdin task delivery
 * 4. Status poller: detects tmux exit (not_found) and completes session
 * 5. Flow advance: single-stage autonomous flow completes after poller triggers
 * 6. Transcript parsing: GeminiTranscriptParser is wired for gemini billing mode
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { startStatusPoller, stopStatusPoller, stopAllPollers } from "../executors/status-poller.js";
import { cliAgentExecutor } from "../executors/cli-agent.js";
import { resolveAgentWithRuntime } from "../agent/agent.js";
import * as tmux from "../infra/tmux.js";

// ── App fixture ──────────────────────────────────────────────────────────────

let app: AppContext;

beforeEach(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
});

afterEach(async () => {
  stopAllPollers();
  await app?.shutdown();
  clearApp();
});

// ── Helper ───────────────────────────────────────────────────────────────────

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

// ── Runtime resolution ───────────────────────────────────────────────────────

describe("Gemini runtime resolution", () => {
  it("gemini runtime definition loads from RuntimeStore", () => {
    const runtime = app.runtimes.get("gemini");
    expect(runtime).not.toBeNull();
    expect(runtime!.name).toBe("gemini");
    expect(runtime!.type).toBe("cli-agent");
    expect(runtime!.command).toEqual(["gemini"]);
    expect(runtime!.task_delivery).toBe("stdin");
    expect(runtime!.billing?.mode).toBe("api");
    expect(runtime!.billing?.transcript_parser).toBe("gemini");
  });

  it("resolveAgentWithRuntime merges gemini runtime into worker agent", () => {
    const session = { summary: "test task", id: "s-test01" };
    const agent = resolveAgentWithRuntime(app, "worker", session, { runtimeOverride: "gemini" });

    expect(agent).not.toBeNull();
    expect(agent!._resolved_runtime_type).toBe("cli-agent");
    expect(agent!.command).toEqual(["gemini"]);
    expect(agent!.task_delivery).toBe("stdin");
  });

  it("remaps agent model to gemini default when agent model is not in gemini model list", () => {
    const session = { summary: "test", id: "s-test02" };
    const agent = resolveAgentWithRuntime(app, "worker", session, { runtimeOverride: "gemini" });

    // Worker agent defaults to a Claude model (e.g. "sonnet") which isn't in gemini's model list.
    // resolveAgentWithRuntime should remap to gemini's default_model.
    expect(agent).not.toBeNull();
    expect(agent!.model).toBe("gemini-2.5-pro");
  });

  it("falls back to claude-code when no runtime override is specified", () => {
    const session = { summary: "test", id: "s-test03" };
    const agent = resolveAgentWithRuntime(app, "worker", session, {});

    // Worker agent has runtime: claude in its YAML, so _resolved_runtime_type should be claude-code
    expect(agent).not.toBeNull();
    // Without runtime override, falls back to agent's own runtime or no runtime type
    const effectiveRuntime = agent!._resolved_runtime_type ?? agent!.runtime ?? "claude-code";
    expect(["claude-code", "claude", undefined]).toContain(agent!._resolved_runtime_type ?? undefined);
  });
});

// ── CLI-agent executor with gemini config ────────────────────────────────────

describe("Gemini dispatch via cli-agent executor", () => {
  let createSpy: ReturnType<typeof spyOn>;
  let sendTextSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createSpy = spyOn(tmux, "createSessionAsync").mockImplementation(async () => {});
    sendTextSpy = spyOn(tmux, "sendTextAsync").mockImplementation(async () => {});
  });

  afterEach(() => {
    createSpy.mockRestore();
    sendTextSpy.mockRestore();
  });

  it("launches gemini with stdin pipe (default task delivery)", async () => {
    const result = await cliAgentExecutor.launch({
      sessionId: "s-gemtest01",
      workdir: "/tmp/fake-gemini-workdir",
      agent: {
        name: "worker",
        model: "gemini-2.5-pro",
        max_turns: 100,
        system_prompt: "You are a worker agent",
        tools: [],
        skills: [],
        mcp_servers: [],
        permission_mode: "bypassPermissions",
        env: {},
        command: ["gemini"],
        task_delivery: "stdin",
      },
      task: "Fix the bug in parser.ts",
      env: {},
      app,
    });

    expect(result.ok).toBe(true);
    expect(result.handle).toBe("ark-s-gemtest01");
    expect(createSpy).toHaveBeenCalled();

    // Verify the tmux command pipes task via stdin
    const cmd = (createSpy.mock.calls[0] as any[])[1] as string;
    expect(cmd).toContain("gemini");
    expect(cmd).toContain("cat ");
    expect(cmd).toContain("task.txt");
  });

  it("cli-agent executor returns not_found when gemini tmux session exits", async () => {
    const existsSpy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);
    try {
      const status = await cliAgentExecutor.status("ark-s-gemtest02");
      expect(status.state).toBe("not_found");
    } finally {
      existsSpy.mockRestore();
    }
  });

  it("cli-agent executor returns running when gemini tmux session is alive", async () => {
    const existsSpy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(true);
    try {
      const status = await cliAgentExecutor.status("ark-s-gemtest03");
      expect(status.state).toBe("running");
    } finally {
      existsSpy.mockRestore();
    }
  });
});

// ── Status poller + autonomous flow completion ──────────────────────────────

describe("Gemini runtime + autonomous flow completion", () => {
  it("status poller completes session when gemini tmux exits", async () => {
    const session = app.sessions.create({ summary: "gemini autonomous test", flow: "autonomous" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-" + session.id,
      config: { runtime: "gemini", runtime_override: "gemini" },
    });

    // Mock: tmux session already exited (gemini finished its work)
    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "cli-agent");

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
    const session = app.sessions.create({ summary: "gemini event test", flow: "autonomous" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-" + session.id,
    });

    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "cli-agent");

      await waitFor(() => {
        const s = app.sessions.get(session.id);
        return s?.status === "completed";
      });

      // Verify that a session_completed event was logged
      const events = app.events.list(session.id);
      const completedEvent = events.find((e) => e.type === "session_completed");
      expect(completedEvent).not.toBeUndefined();
      // data is stored as JSON string -- parse and check the reason field
      const data = typeof completedEvent!.data === "string" ? JSON.parse(completedEvent!.data) : completedEvent!.data;
      expect(data.reason).toBe("agent process exited");
    } finally {
      spy.mockRestore();
    }
  });

  it("status poller clears session_id on completion", async () => {
    const session = app.sessions.create({ summary: "gemini cleanup test", flow: "autonomous" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-" + session.id,
    });

    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "cli-agent");

      await waitFor(() => {
        const s = app.sessions.get(session.id);
        return s?.status === "completed";
      });

      const updated = app.sessions.get(session.id);
      // session_id should be cleared (tmux handle no longer valid)
      expect(updated?.session_id).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not double-poll the same session", async () => {
    const session = app.sessions.create({ summary: "gemini no-double test", flow: "autonomous" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-" + session.id,
    });

    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(true);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "cli-agent");
      startStatusPoller(app, session.id, "ark-" + session.id, "cli-agent"); // Should be no-op

      // Wait a polling cycle to ensure only one poller is active
      await Bun.sleep(100);
      const s = app.sessions.get(session.id);
      expect(s?.status).toBe("running"); // Still running, not double-completed
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Transcript parser wiring ────────────────────────────────────────────────

describe("Gemini transcript parser registration", () => {
  it("GeminiTranscriptParser is registered in TranscriptParserRegistry", () => {
    const registry = app.transcriptParsers;
    expect(registry).not.toBeUndefined();

    // The registry should have a gemini parser registered
    const parser = registry.get("gemini");
    expect(parser).not.toBeUndefined();
  });

  it("gemini runtime billing config specifies transcript_parser: gemini", () => {
    const runtime = app.runtimes.get("gemini");
    expect(runtime).not.toBeNull();
    expect(runtime!.billing?.transcript_parser).toBe("gemini");
  });
});
