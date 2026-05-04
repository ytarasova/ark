import { describe, it, expect } from "bun:test";
import { validateAgentRuntime } from "./agent-store.js";
import type { AgentDefinition } from "../agent/agent.js";

const baseAgent: AgentDefinition = {
  name: "test-agent",
  description: "",
  model: "sonnet",
  max_turns: 200,
  system_prompt: "test",
  tools: [],
  mcp_servers: [],
  skills: [],
  memories: [],
  context: [],
  permission_mode: "bypassPermissions",
  env: {},
};

describe("validateAgentRuntime", () => {
  it("returns null for agent with runtime field", () => {
    expect(validateAgentRuntime({ ...baseAgent, runtime: "claude-code" })).toBeNull();
  });

  it("returns error message for agent without runtime field", () => {
    const result = validateAgentRuntime(baseAgent);
    expect(typeof result).toBe("string");
    expect(result).toContain("test-agent");
    expect(result).toContain("no runtime field");
  });

  it("returns error message for agent with empty runtime field", () => {
    const result = validateAgentRuntime({ ...baseAgent, runtime: "" });
    expect(typeof result).toBe("string");
  });

  it("returns error message for agent with whitespace-only runtime field", () => {
    const result = validateAgentRuntime({ ...baseAgent, runtime: "   " });
    expect(typeof result).toBe("string");
  });
});
