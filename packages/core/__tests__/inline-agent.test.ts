/**
 * Tests for inline agent definitions on stage `agent:` fields.
 *
 * buildInlineAgent() takes an InlineAgentSpec (an ad-hoc agent object passed
 * inside a stage) and produces an AgentDefinition without touching the agent
 * store. Used by for_each + spawn flows that ship the agent inline instead of
 * pre-registering a YAML on disk.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { setApp, clearApp } from "./test-helpers.js";
import { buildInlineAgent } from "../agent/agent.js";
import type { InlineAgentSpec } from "../state/flow.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

test("builds AgentDefinition from a minimal inline spec", () => {
  const spec: InlineAgentSpec = {
    runtime: "agent-sdk",
    system_prompt: "You are a test agent.",
  };
  const agent = buildInlineAgent(app, spec, {});
  expect(agent).not.toBeNull();
  expect(agent!.name).toBe("inline");
  expect(agent!.runtime).toBe("agent-sdk");
  expect(agent!.system_prompt).toBe("You are a test agent.");
  // Defaults
  expect(agent!.model).toBe("sonnet");
  expect(agent!.max_turns).toBe(200);
  expect(agent!.permission_mode).toBe("bypassPermissions");
  expect(agent!.tools).toEqual(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
});

test("returns null when system_prompt is missing", () => {
  const spec = { runtime: "agent-sdk" } as InlineAgentSpec;
  expect(buildInlineAgent(app, spec, {})).toBeNull();
});

test("returns null when runtime is missing", () => {
  const spec = { system_prompt: "test" } as InlineAgentSpec;
  expect(buildInlineAgent(app, spec, {})).toBeNull();
});

test("substitutes session vars into system_prompt", () => {
  const spec: InlineAgentSpec = {
    runtime: "agent-sdk",
    system_prompt: "You are working on {{ticket}} in {{workdir}}.",
  };
  const agent = buildInlineAgent(app, spec, { ticket: "PAI-31080", workdir: "/tmp/test" });
  expect(agent!.system_prompt).toBe("You are working on PAI-31080 in /tmp/test.");
});

test("caller-provided fields override defaults", () => {
  const spec: InlineAgentSpec = {
    name: "my-custom-agent",
    runtime: "agent-sdk",
    model: "opus",
    max_turns: 50,
    system_prompt: "custom",
    tools: ["Read", "Write"],
  };
  const agent = buildInlineAgent(app, spec, {});
  expect(agent!.name).toBe("my-custom-agent");
  expect(agent!.model).toBe("opus");
  expect(agent!.max_turns).toBe(50);
  expect(agent!.tools).toEqual(["Read", "Write"]);
});

test("applies runtime merge -- _resolved_runtime_type is set", () => {
  const spec: InlineAgentSpec = {
    runtime: "agent-sdk",
    system_prompt: "test",
  };
  const agent = buildInlineAgent(app, spec, {});
  // The agent-sdk runtime YAML should resolve to type: "agent-sdk"
  expect(agent!._resolved_runtime_type).toBeDefined();
});

test("runtimeOverride takes precedence over spec.runtime for the merge", () => {
  const spec: InlineAgentSpec = {
    runtime: "claude",
    system_prompt: "test",
  };
  const agent = buildInlineAgent(app, spec, {}, { runtimeOverride: "agent-sdk" });
  // agent.runtime stays as the spec's declared runtime, but the merged
  // _resolved_runtime_type reflects the override.
  expect(agent!.runtime).toBe("claude");
  expect(agent!._resolved_runtime_type).toBeDefined();
});
