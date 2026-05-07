/**
 * Skill CRUD tools. Thin pass-throughs to `app.skills`. The schema is loose
 * (`.passthrough()`) because skill bodies vary across YAML files and we
 * don't gain anything from re-validating known fields here -- the store
 * itself doesn't enforce a schema beyond `name`.
 */

import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

const skillDefinitionShape = z
  .object({
    name: z.string(),
    description: z.string(),
    body: z.string(),
  })
  .passthrough();

const skillList: ToolDef = {
  name: "skill_list",
  description: "List all skills visible to the tenant (builtin, global, and project scope).",
  inputSchema: z.object({}),
  handler: async (_input, { app }) => app.skills.list(),
};

const skillShow: ToolDef = {
  name: "skill_show",
  description: "Get a skill definition by name.",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const parsed = input as { name: string };
    const skill = app.skills.get(parsed.name);
    if (!skill) throw new Error(`Skill not found: ${parsed.name}`);
    return skill;
  },
};

const skillCreate: ToolDef = {
  name: "skill_create",
  description: "Create a new skill at global scope. Serialised to ~/.ark/skills/<name>.yaml.",
  inputSchema: z.object({ definition: skillDefinitionShape }),
  handler: async (input, { app }) => {
    const parsed = input as { definition: { name: string } & Record<string, unknown> };
    const def = parsed.definition;
    if (app.skills.get(def.name)) throw new Error(`Skill already exists: ${def.name}`);
    app.skills.save(def.name, def as never, "global");
    return { name: def.name };
  },
};

const skillUpdate: ToolDef = {
  name: "skill_update",
  description: "Patch an existing skill. Shallow-merges `patch` into the current definition.",
  inputSchema: z.object({ name: z.string(), patch: z.record(z.string(), z.unknown()) }),
  handler: async (input, { app }) => {
    const parsed = input as { name: string; patch: Record<string, unknown> };
    const existing = app.skills.get(parsed.name);
    if (!existing) throw new Error(`Skill not found: ${parsed.name}`);
    const merged = { ...existing, ...parsed.patch, name: parsed.name };
    app.skills.save(parsed.name, merged as never, "global");
    return { name: parsed.name };
  },
};

sharedRegistry.register(skillList);
sharedRegistry.register(skillShow);
sharedRegistry.register(skillCreate);
sharedRegistry.register(skillUpdate);
