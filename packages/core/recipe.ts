/**
 * Recipe registry - types and utility functions for parameterized flow templates.
 *
 * Recipes are YAML files with: name, description, flow, agent, compute, variables, defaults.
 * Three-tier resolution: builtin (recipes/), global (~/.ark/recipes/), project (.ark/recipes/).
 *
 * CRUD operations are on the RecipeStore (app.recipes). This module provides
 * instantiation, validation, and sub-recipe resolution.
 */

import type { AppContext } from "./app.js";
import type { Session } from "../types/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RecipeVariable {
  name: string;
  description: string;
  required?: boolean;
  default?: string;
}

export interface RecipeParameter {
  key: string;
  type: "string" | "number" | "boolean" | "select" | "file";
  description?: string;
  required?: boolean;
  default?: string;
  options?: string[];  // for "select" type
}

export interface SubRecipeRef {
  name: string;        // identifier for this sub-recipe
  recipe: string;      // recipe name to invoke
  values?: Record<string, string>;  // pre-filled parameter values
}

export interface RecipeDefinition {
  name: string;
  description: string;
  repo?: string;
  flow: string;
  agent?: string;
  compute?: string;
  group?: string;
  variables: RecipeVariable[];
  parameters?: RecipeParameter[];
  defaults?: Record<string, string>;
  sub_recipes?: SubRecipeRef[];
  _source?: "builtin" | "project" | "global";
}

export interface RecipeInstance {
  repo?: string;
  summary?: string;
  ticket?: string;
  flow: string;
  agent?: string;
  compute?: string;
  group?: string;
}

// ── Instantiation ──────────────────────────────────────────────────────────

export function instantiateRecipe(recipe: RecipeDefinition, values: Record<string, string>): RecipeInstance {
  const merged = { ...recipe.defaults, ...values };
  return {
    repo: recipe.repo ?? merged.repo,
    summary: merged.summary,
    ticket: merged.ticket,
    flow: recipe.flow,
    agent: recipe.agent,
    compute: recipe.compute ?? merged.compute,
    group: recipe.group ?? merged.group,
  };
}

// ── Sub-recipe resolution ─────────────────────────────────────────────────

/** Resolve a sub-recipe reference into a full recipe instance. */
export function resolveSubRecipe(app: AppContext, ref: SubRecipeRef, parentVars?: Record<string, string>): {
  recipe: RecipeDefinition | null;
  instance: RecipeInstance | null;
} {
  const recipe = app.recipes.get(ref.recipe);
  if (!recipe) return { recipe: null, instance: null };

  const mergedValues = { ...parentVars, ...ref.values };
  const instance = instantiateRecipe(recipe, mergedValues);
  return { recipe, instance };
}

/** List sub-recipes available in a recipe. */
export function listSubRecipes(app: AppContext, recipeName: string): SubRecipeRef[] {
  const recipe = app.recipes.get(recipeName);
  return recipe?.sub_recipes ?? [];
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Validate parameter values against recipe parameter definitions. */
export function validateRecipeParams(recipe: RecipeDefinition, values: Record<string, string>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const param of recipe.parameters ?? []) {
    const val = values[param.key];
    if (param.required && !val && !param.default) {
      errors.push(`Required parameter '${param.key}' is missing`);
    }
    if (val && param.type === "number" && isNaN(Number(val))) {
      errors.push(`Parameter '${param.key}' must be a number`);
    }
    if (val && param.type === "boolean" && !["true", "false"].includes(val)) {
      errors.push(`Parameter '${param.key}' must be true or false`);
    }
    if (val && param.type === "select" && param.options && !param.options.includes(val)) {
      errors.push(`Parameter '${param.key}' must be one of: ${param.options.join(", ")}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── Session to recipe ──────────────────────────────────────────────────────

/** Create a recipe from an existing session's config */
export function sessionToRecipe(session: Session, name: string): RecipeDefinition {
  return {
    name,
    description: session.summary ?? `Recipe from session ${session.id}`,
    repo: session.repo ?? undefined,
    flow: session.flow,
    agent: session.agent ?? undefined,
    compute: session.compute_name ?? undefined,
    group: session.group_name ?? undefined,
    variables: [
      { name: "summary", description: "Task description", required: true },
    ],
    defaults: {
      summary: session.summary ?? "",
    },
  };
}
