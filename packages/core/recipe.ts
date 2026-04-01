/**
 * Recipe registry - CRUD for parameterized flow templates.
 *
 * Recipes are YAML files with: name, description, flow, agent, compute, variables, defaults.
 * Three-tier resolution: builtin (recipes/), global (~/.ark/recipes/), project (.ark/recipes/).
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { parse as parseYaml } from "yaml";
import { ARK_DIR } from "./store.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RecipeVariable {
  name: string;
  description: string;
  required?: boolean;
  default?: string;
}

export interface RecipeDefinition {
  name: string;
  description: string;
  flow: string;
  agent?: string;
  compute?: string;
  variables: RecipeVariable[];
  defaults?: Record<string, string>;
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

// ── Paths ───────────────────────────────────────────────────────────────────

import { fileURLToPath } from "url";
import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "..", "..", "recipes");

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadFromDir(dir: string, source: RecipeDefinition["_source"]): RecipeDefinition[] {
  if (!existsSync(dir)) return [];
  const recipes: RecipeDefinition[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const parsed = parseYaml(content) as RecipeDefinition;
      parsed._source = source;
      if (!parsed.name) parsed.name = basename(file, file.endsWith(".yaml") ? ".yaml" : ".yml");
      if (!parsed.variables) parsed.variables = [];
      recipes.push(parsed);
    } catch (e: any) {
      console.error(`[recipe] failed to load ${file}:`, e?.message ?? e);
    }
  }
  return recipes;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function listRecipes(projectRoot?: string): RecipeDefinition[] {
  const builtin = loadFromDir(BUILTIN_DIR, "builtin");
  const global = loadFromDir(join(ARK_DIR(), "recipes"), "global");
  const project = projectRoot ? loadFromDir(join(projectRoot, ".ark", "recipes"), "project") : [];
  const byName = new Map<string, RecipeDefinition>();
  for (const r of builtin) byName.set(r.name, r);
  for (const r of global) byName.set(r.name, r);
  for (const r of project) byName.set(r.name, r);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadRecipe(name: string, projectRoot?: string): RecipeDefinition | null {
  return listRecipes(projectRoot).find(r => r.name === name) ?? null;
}

export function instantiateRecipe(recipe: RecipeDefinition, values: Record<string, string>): RecipeInstance {
  const merged = { ...recipe.defaults, ...values };
  return {
    repo: merged.repo,
    summary: merged.summary,
    ticket: merged.ticket,
    flow: recipe.flow,
    agent: recipe.agent,
    compute: recipe.compute ?? merged.compute,
    group: merged.group,
  };
}
