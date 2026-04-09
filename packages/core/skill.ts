/**
 * Skill registry - CRUD for reusable prompt fragments.
 *
 * Skills are YAML files with: name, description, prompt, tags.
 * Three-tier resolution: builtin (skills/), global (~/.ark/skills/), project (.ark/skills/).
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { join, basename } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ARK_DIR } from "./paths.js";
import { getApp } from "./app.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  tags?: string[];
  _source?: "builtin" | "project" | "global";
}

// ── Paths ───────────────────────────────────────────────────────────────────

import { fileURLToPath } from "url";
import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "..", "..", "skills");

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadFromDir(dir: string, source: SkillDefinition["_source"]): SkillDefinition[] {
  if (!existsSync(dir)) return [];
  const skills: SkillDefinition[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const parsed = parseYaml(content) as SkillDefinition;
      parsed._source = source;
      if (!parsed.name) parsed.name = basename(file, file.endsWith(".yaml") ? ".yaml" : ".yml");
      skills.push(parsed);
    } catch (e: any) {
      console.error(`[skill] failed to load ${file}:`, e?.message ?? e);
    }
  }
  return skills;
}

// ── Public API (backward-compat wrappers delegating to AppContext stores) ───

/** @deprecated Use app.skills.list(projectRoot) instead */
export function listSkills(projectRoot?: string): SkillDefinition[] {
  try { return getApp().skills.list(projectRoot); } catch {
    // Fallback for cases where AppContext is not booted
    const builtin = loadFromDir(BUILTIN_DIR, "builtin");
    const global = loadFromDir(join(ARK_DIR(), "skills"), "global");
    const project = projectRoot ? loadFromDir(join(projectRoot, ".ark", "skills"), "project") : [];

    const byName = new Map<string, SkillDefinition>();
    for (const s of builtin) byName.set(s.name, s);
    for (const s of global) byName.set(s.name, s);
    for (const s of project) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** @deprecated Use app.skills.get(name, projectRoot) instead */
export function loadSkill(name: string, projectRoot?: string): SkillDefinition | null {
  try { return getApp().skills.get(name, projectRoot); } catch {
    return listSkills(projectRoot).find(s => s.name === name) ?? null;
  }
}

/** @deprecated Use app.skills.save(name, skill, scope, projectRoot) instead */
export function saveSkill(skill: SkillDefinition, scope: "project" | "global" = "global", projectRoot?: string): void {
  try {
    getApp().skills.save(skill.name, skill, scope, projectRoot);
    return;
  } catch { /* fallback */ }
  const dir = scope === "project" && projectRoot
    ? join(projectRoot, ".ark", "skills")
    : join(ARK_DIR(), "skills");
  mkdirSync(dir, { recursive: true });
  const { _source, ...data } = skill;
  writeFileSync(join(dir, `${skill.name}.yaml`), stringifyYaml(data));
}

/** @deprecated Use app.skills.delete(name, scope, projectRoot) instead */
export function deleteSkill(name: string, scope: "project" | "global" = "global", projectRoot?: string): void {
  try {
    getApp().skills.delete(name, scope, projectRoot);
    return;
  } catch { /* fallback */ }
  const dir = scope === "project" && projectRoot
    ? join(projectRoot, ".ark", "skills")
    : join(ARK_DIR(), "skills");
  for (const ext of [".yaml", ".yml"]) {
    const path = join(dir, `${name}${ext}`);
    if (existsSync(path)) { unlinkSync(path); return; }
  }
}
