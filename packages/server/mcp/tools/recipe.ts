/**
 * Recipe CRUD tools. Thin pass-throughs to `app.recipes`. Schema is loose
 * because recipe payloads carry many optional fields (variables, parameters,
 * defaults, sub_recipes) and validating each one here would duplicate the
 * recipe.ts type without adding value -- the store accepts the YAML as-is.
 */

import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

const recipeDefinitionShape = z.object({ name: z.string() }).passthrough();

const recipeList: ToolDef = {
  name: "recipe_list",
  description: "List all recipes visible to the tenant (builtin, global, and project scope).",
  inputSchema: z.object({}),
  handler: async (_input, { app }) => app.recipes.list(),
};

const recipeShow: ToolDef = {
  name: "recipe_show",
  description: "Get a recipe definition by name.",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const parsed = input as { name: string };
    const recipe = app.recipes.get(parsed.name);
    if (!recipe) throw new Error(`Recipe not found: ${parsed.name}`);
    return recipe;
  },
};

const recipeCreate: ToolDef = {
  name: "recipe_create",
  description: "Create a new recipe at global scope. Serialised to ~/.ark/recipes/<name>.yaml.",
  inputSchema: z.object({ definition: recipeDefinitionShape }),
  handler: async (input, { app }) => {
    const parsed = input as { definition: { name: string } & Record<string, unknown> };
    const def = parsed.definition;
    if (app.recipes.get(def.name)) throw new Error(`Recipe already exists: ${def.name}`);
    app.recipes.save(def.name, def as never, "global");
    return { name: def.name };
  },
};

const recipeUpdate: ToolDef = {
  name: "recipe_update",
  description: "Patch an existing recipe. Shallow-merges `patch` into the current definition.",
  inputSchema: z.object({ name: z.string(), patch: z.record(z.string(), z.unknown()) }),
  handler: async (input, { app }) => {
    const parsed = input as { name: string; patch: Record<string, unknown> };
    const existing = app.recipes.get(parsed.name);
    if (!existing) throw new Error(`Recipe not found: ${parsed.name}`);
    const merged = { ...existing, ...parsed.patch, name: parsed.name };
    app.recipes.save(parsed.name, merged as never, "global");
    return { name: parsed.name };
  },
};

sharedRegistry.register(recipeList);
sharedRegistry.register(recipeShow);
sharedRegistry.register(recipeCreate);
sharedRegistry.register(recipeUpdate);
