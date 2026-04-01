/**
 * Recipe registry - CRUD for parameterized flow templates.
 *
 * Recipes are YAML files with: name, description, flow, agent, compute, variables, defaults.
 * Three-tier resolution: builtin (recipes/), global (~/.ark/recipes/), project (.ark/recipes/).
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { join, basename } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ARK_DIR } from "./store.js";
import type { Session } from "./store.js";

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
  repo?: string;
  flow: string;
  agent?: string;
  compute?: string;
  group?: string;
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
    repo: recipe.repo ?? merged.repo,
    summary: merged.summary,
    ticket: merged.ticket,
    flow: recipe.flow,
    agent: recipe.agent,
    compute: recipe.compute ?? merged.compute,
    group: recipe.group ?? merged.group,
  };
}

export function saveRecipe(recipe: RecipeDefinition, scope: "project" | "global", projectRoot?: string): void {
  const dir = scope === "project" && projectRoot
    ? join(projectRoot, ".ark", "recipes")
    : join(ARK_DIR(), "recipes");
  mkdirSync(dir, { recursive: true });
  const { _source, ...data } = recipe;
  writeFileSync(join(dir, `${recipe.name}.yaml`), stringifyYaml(data));
}

export function deleteRecipe(name: string, scope: "project" | "global", projectRoot?: string): void {
  const dir = scope === "project" && projectRoot
    ? join(projectRoot, ".ark", "recipes")
    : join(ARK_DIR(), "recipes");
  for (const ext of [".yaml", ".yml"]) {
    const path = join(dir, `${name}${ext}`);
    if (existsSync(path)) { unlinkSync(path); return; }
  }
}

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
