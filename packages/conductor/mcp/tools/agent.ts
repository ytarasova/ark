/**
 * Agent CRUD tools. Thin pass-throughs to `app.agents`. Mirrors the JSON-RPC
 * agent handlers so external clients can manage agent definitions through MCP.
 */

import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

// Mirrors AgentDefinition from packages/core/agent/agent.ts. Optional fields
// match the runtime/command/task_delivery/recipe lookup in agent dispatch.
const agentDefinitionShape = z.object({
  name: z.string(),
  description: z.string(),
  model: z.string(),
  max_turns: z.number().int().positive(),
  system_prompt: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
  skills: z.array(z.string()),
  memories: z.array(z.string()),
  context: z.array(z.string()),
  permission_mode: z.string(),
  env: z.record(z.string(), z.string()),
  runtime: z.string().optional(),
  command: z.array(z.string()).optional(),
  task_delivery: z.enum(["stdin", "file", "arg"]).optional(),
  recipe: z.string().optional(),
  sub_recipes: z.array(z.string()).optional(),
});

const agentList: ToolDef = {
  name: "agent_list",
  description: "List all agents visible to the tenant (builtin, global, and project scope).",
  inputSchema: z.object({}),
  handler: async (_input, { app }) => app.agents.list(),
};

const agentShow: ToolDef = {
  name: "agent_show",
  description: "Get an agent definition by name.",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const parsed = input as { name: string };
    const agent = app.agents.get(parsed.name);
    if (!agent) throw new Error(`Agent not found: ${parsed.name}`);
    return agent;
  },
};

const agentCreate: ToolDef = {
  name: "agent_create",
  description: "Create a new agent at global scope. Serialised to ~/.ark/agents/<name>.yaml.",
  inputSchema: z.object({ definition: agentDefinitionShape }),
  handler: async (input, { app }) => {
    const parsed = input as { definition: { name: string } & Record<string, unknown> };
    const def = parsed.definition;
    if (app.agents.get(def.name)) throw new Error(`Agent already exists: ${def.name}`);
    app.agents.save(def.name, def as never, "global");
    return { name: def.name };
  },
};

const agentUpdate: ToolDef = {
  name: "agent_update",
  description: "Patch an existing agent. Shallow-merges `patch` into the current definition.",
  inputSchema: z.object({ name: z.string(), patch: z.record(z.string(), z.unknown()) }),
  handler: async (input, { app }) => {
    const parsed = input as { name: string; patch: Record<string, unknown> };
    const existing = app.agents.get(parsed.name);
    if (!existing) throw new Error(`Agent not found: ${parsed.name}`);
    const merged = { ...existing, ...parsed.patch, name: parsed.name };
    app.agents.save(parsed.name, merged as never, "global");
    return { name: parsed.name };
  },
};

sharedRegistry.register(agentList);
sharedRegistry.register(agentShow);
sharedRegistry.register(agentCreate);
sharedRegistry.register(agentUpdate);
