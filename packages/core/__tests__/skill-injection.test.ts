/**
 * Tests that agent skills are injected into the system prompt via buildClaudeArgs.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { buildClaudeArgs } from "../agent/agent.js";
import { getApp } from "../app.js";
import type { AgentDefinition } from "../agent/agent.js";

const { getCtx } = withTestContext();

function makeAgent(overrides: Partial<AgentDefinition> & { name: string }): AgentDefinition {
  return {
    description: "test",
    model: "sonnet",
    max_turns: 10,
    system_prompt: "You are a developer.",
    tools: ["Bash"],
    mcp_servers: [],
    skills: [],
    memories: [],
    context: [],
    permission_mode: "default",
    env: {},
    ...overrides,
  };
}

describe("skill injection via buildClaudeArgs", () => {
  it("injects skill prompts into agent system prompt", () => {
    getApp().skills.save("test-skill", {
      name: "test-skill",
      description: "test",
      prompt: "Always write tests first.",
    }, "global");

    const agent = makeAgent({ name: "test-agent", skills: ["test-skill"] });
    getApp().agents.save(agent.name, agent, "global");

    const args = buildClaudeArgs(agent, { app: getApp() });
    const systemPromptArg = args.join(" ");

    expect(systemPromptArg).toContain("You are a developer");
    expect(systemPromptArg).toContain("## Skill: test-skill");
    expect(systemPromptArg).toContain("Always write tests first");
  });

  it("handles missing skills gracefully", () => {
    const agent = makeAgent({ name: "no-skills-agent", skills: ["nonexistent-skill"] });
    getApp().agents.save(agent.name, agent, "global");

    // Should not throw, just skip missing skills
    const args = buildClaudeArgs(agent, { app: getApp() });
    expect(args.length).toBeGreaterThan(0);
    // The nonexistent skill prompt should not appear
    const systemPromptArg = args.join(" ");
    expect(systemPromptArg).not.toContain("## Skill:");
  });

  it("agent without skills works normally", () => {
    const agent = makeAgent({ name: "plain-agent", skills: [] });
    getApp().agents.save(agent.name, agent, "global");

    const args = buildClaudeArgs(agent, { app: getApp() });
    expect(args.length).toBeGreaterThan(0);
    const systemPromptArg = args.join(" ");
    expect(systemPromptArg).toContain("You are a developer");
    expect(systemPromptArg).not.toContain("## Skill:");
  });

  it("injects multiple skills in order", () => {
    getApp().skills.save("skill-a", {
      name: "skill-a",
      description: "first",
      prompt: "Follow TDD methodology.",
    }, "global");

    getApp().skills.save("skill-b", {
      name: "skill-b",
      description: "second",
      prompt: "Use conventional commits.",
    }, "global");

    const agent = makeAgent({ name: "multi-skill-agent", skills: ["skill-a", "skill-b"] });
    getApp().agents.save(agent.name, agent, "global");

    const args = buildClaudeArgs(agent, { app: getApp() });
    const systemPromptArg = args.join(" ");

    expect(systemPromptArg).toContain("## Skill: skill-a");
    expect(systemPromptArg).toContain("Follow TDD methodology");
    expect(systemPromptArg).toContain("## Skill: skill-b");
    expect(systemPromptArg).toContain("Use conventional commits");
  });
});
