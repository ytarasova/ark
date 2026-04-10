/**
 * SkillStore - interface + file-backed implementation for skill definitions.
 *
 * Replaces the free functions in skill.ts that read from the filesystem via
 * global state (ARK_DIR). Consumers receive a SkillStore from AppContext
 * and call store methods instead.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { join, basename } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SkillDefinition } from "../agent/skill.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillStore {
  list(projectRoot?: string): SkillDefinition[];
  get(name: string, projectRoot?: string): SkillDefinition | null;
  save(name: string, skill: SkillDefinition, scope?: "global" | "project", projectRoot?: string): void;
  delete(name: string, scope?: "global" | "project", projectRoot?: string): boolean;
}

// ── File-backed implementation ──────────────────────────────────────────────

export interface FileSkillStoreOpts {
  builtinDir: string;
  userDir: string;
  projectDir?: string;
}

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

export class FileSkillStore implements SkillStore {
  private builtinDir: string;
  private userDir: string;
  private projectDir?: string;

  constructor(opts: FileSkillStoreOpts) {
    this.builtinDir = opts.builtinDir;
    this.userDir = opts.userDir;
    this.projectDir = opts.projectDir;
  }

  list(projectRoot?: string): SkillDefinition[] {
    const builtin = loadFromDir(this.builtinDir, "builtin");
    const global = loadFromDir(this.userDir, "global");
    const projDir = projectRoot ? join(projectRoot, ".ark", "skills") : this.projectDir;
    const project = projDir ? loadFromDir(projDir, "project") : [];

    // Three-tier: project overrides global overrides builtin
    const byName = new Map<string, SkillDefinition>();
    for (const s of builtin) byName.set(s.name, s);
    for (const s of global) byName.set(s.name, s);
    for (const s of project) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string, projectRoot?: string): SkillDefinition | null {
    return this.list(projectRoot).find(s => s.name === name) ?? null;
  }

  save(name: string, skill: SkillDefinition, scope: "global" | "project" = "global", projectRoot?: string): void {
    const dir = scope === "project" && projectRoot
      ? join(projectRoot, ".ark", "skills")
      : this.userDir;
    mkdirSync(dir, { recursive: true });
    const { _source, ...data } = skill;
    writeFileSync(join(dir, `${name}.yaml`), stringifyYaml(data));
  }

  delete(name: string, scope: "global" | "project" = "global", projectRoot?: string): boolean {
    const dir = scope === "project" && projectRoot
      ? join(projectRoot, ".ark", "skills")
      : this.userDir;
    for (const ext of [".yaml", ".yml"]) {
      const path = join(dir, `${name}${ext}`);
      if (existsSync(path)) { unlinkSync(path); return true; }
    }
    return false;
  }
}
