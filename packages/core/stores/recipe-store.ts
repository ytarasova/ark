/**
 * RecipeStore - interface + file-backed implementation for recipe definitions.
 *
 * Replaces the free functions in recipe.ts that read from the filesystem via
 * global state (ARK_DIR). Consumers receive a RecipeStore from AppContext
 * and call store methods instead.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { join, basename } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RecipeDefinition } from "../agent/recipe.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RecipeStore {
  list(projectRoot?: string): RecipeDefinition[];
  get(name: string, projectRoot?: string): RecipeDefinition | null;
  save(name: string, recipe: RecipeDefinition, scope?: "global" | "project", projectRoot?: string): void;
  delete(name: string, scope?: "global" | "project", projectRoot?: string): boolean;
}

// ── File-backed implementation ──────────────────────────────────────────────

export interface FileRecipeStoreOpts {
  builtinDir: string;
  userDir: string;
  projectDir?: string;
}

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

export class FileRecipeStore implements RecipeStore {
  private builtinDir: string;
  private userDir: string;
  private projectDir?: string;

  constructor(opts: FileRecipeStoreOpts) {
    this.builtinDir = opts.builtinDir;
    this.userDir = opts.userDir;
    this.projectDir = opts.projectDir;
  }

  list(projectRoot?: string): RecipeDefinition[] {
    const builtin = loadFromDir(this.builtinDir, "builtin");
    const global = loadFromDir(this.userDir, "global");
    const projDir = projectRoot ? join(projectRoot, ".ark", "recipes") : this.projectDir;
    const project = projDir ? loadFromDir(projDir, "project") : [];

    const byName = new Map<string, RecipeDefinition>();
    for (const r of builtin) byName.set(r.name, r);
    for (const r of global) byName.set(r.name, r);
    for (const r of project) byName.set(r.name, r);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string, projectRoot?: string): RecipeDefinition | null {
    return this.list(projectRoot).find(r => r.name === name) ?? null;
  }

  save(name: string, recipe: RecipeDefinition, scope: "global" | "project" = "global", projectRoot?: string): void {
    const dir = scope === "project" && projectRoot
      ? join(projectRoot, ".ark", "recipes")
      : this.userDir;
    mkdirSync(dir, { recursive: true });
    const { _source, ...data } = recipe;
    writeFileSync(join(dir, `${name}.yaml`), stringifyYaml(data));
  }

  delete(name: string, scope: "global" | "project" = "global", projectRoot?: string): boolean {
    const dir = scope === "project" && projectRoot
      ? join(projectRoot, ".ark", "recipes")
      : this.userDir;
    for (const ext of [".yaml", ".yml"]) {
      const path = join(dir, `${name}${ext}`);
      if (existsSync(path)) { unlinkSync(path); return true; }
    }
    return false;
  }
}
