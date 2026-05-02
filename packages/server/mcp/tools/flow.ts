/**
 * Flow CRUD tools. Thin pass-throughs to `app.flows`. The MCP surface
 * mirrors the JSON-RPC flow handlers so external clients can manage flows
 * without going through the daemon's bespoke RPC shape.
 */

import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

// `.passthrough()` so YAML-side fields (e.g. `inputs`, `outputs`, `triggers`)
// not modeled here ride through to the store unchanged.
const flowDefinitionShape = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    stages: z.array(z.unknown()),
  })
  .passthrough();

const flowList: ToolDef = {
  name: "flow_list",
  description: "List all flows visible to the tenant (builtin, global, and project scope).",
  inputSchema: z.object({}),
  handler: async (_input, { app }) => app.flows.list(),
};

const flowShow: ToolDef = {
  name: "flow_show",
  description: "Get a flow definition by name.",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const parsed = input as { name: string };
    const flow = app.flows.get(parsed.name);
    if (!flow) throw new Error(`Flow not found: ${parsed.name}`);
    return flow;
  },
};

const flowCreate: ToolDef = {
  name: "flow_create",
  description: "Create a new flow at global scope. Serialised to ~/.ark/flows/<name>.yaml.",
  inputSchema: z.object({ definition: flowDefinitionShape }),
  handler: async (input, { app }) => {
    const parsed = input as { definition: { name: string } & Record<string, unknown> };
    const def = parsed.definition;
    if (app.flows.get(def.name)) throw new Error(`Flow already exists: ${def.name}`);
    app.flows.save(def.name, def as never, "global");
    return { name: def.name };
  },
};

const flowUpdate: ToolDef = {
  name: "flow_update",
  description: "Patch an existing flow. Shallow-merges `patch` into the current definition.",
  inputSchema: z.object({ name: z.string(), patch: z.record(z.string(), z.unknown()) }),
  handler: async (input, { app }) => {
    const parsed = input as { name: string; patch: Record<string, unknown> };
    const existing = app.flows.get(parsed.name);
    if (!existing) throw new Error(`Flow not found: ${parsed.name}`);
    const merged = { ...existing, ...parsed.patch, name: parsed.name };
    app.flows.save(parsed.name, merged as never, "global");
    return { name: parsed.name };
  },
};

sharedRegistry.register(flowList);
sharedRegistry.register(flowShow);
sharedRegistry.register(flowCreate);
sharedRegistry.register(flowUpdate);
