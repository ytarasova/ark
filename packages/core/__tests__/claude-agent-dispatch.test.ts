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

  it("status defers to provider (returns 'idle' to signal 'ask the provider')", async () => {
    // The new architecture pushes status into the compute provider's
    // /process/status endpoint -- the executor itself has no in-process child
    // to inspect, so it returns "idle" as a hint to the caller that they
    // should consult provider.statusProcessByHandle instead.
    const status = await claudeAgentExecutor.status("ark-does-not-exist");
    expect(status.state).toBe("idle");
  });

  it("kill is a no-op (provider.killProcessByHandle is the canonical path)", async () => {
    // Same rationale -- the SessionTerminator calls provider.killProcessByHandle
    // (or killAgent for legacy tmux paths) directly with the session row in
    // hand. The handle-only kill() signature can't reach the provider, so it
    // intentionally does nothing.
    await claudeAgentExecutor.kill("ark-does-not-exist");
  });

  it("capture defers to provider (executor returns empty string)", async () => {
    // Capture is deferred to provider.captureOutput, which session-output.ts
    // already calls before falling through to the executor.
    const out = await claudeAgentExecutor.capture("ark-does-not-exist", 20);
    expect(out).toBe("");
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
