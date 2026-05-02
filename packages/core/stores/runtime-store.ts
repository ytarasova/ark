/**
 * RuntimeStore - interface + file-backed implementation for runtime definitions.
 *
 * Runtimes define HOW an agent runs (LLM backend, CLI tool, command, model list).
 * Roles (agent YAMLs) define WHAT an agent does (prompt, skills, tools).
 *
 * Three-tier resolution: project > user/global > builtin.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { RuntimeDefinition } from "../../types/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RuntimeStore {
  list(): RuntimeDefinition[];
  get(name: string): RuntimeDefinition | null;
  save(name: string, def: RuntimeDefinition, scope?: "global" | "project"): void;
  delete(name: string, scope?: "global" | "project"): boolean;
}

/**
 * Backward-compat aliases for the May 2026 runtime rename. Sessions, agent
 * YAMLs, and external callers persisted before the rename still reference the
 * old names; this map redirects them to the new on-disk YAML files.
 */
export const RUNTIME_NAME_ALIASES: Record<string, string> = {
  claude: "claude-code",
  "agent-sdk": "claude-agent",
};

// ── File-backed implementation ──────────────────────────────────────────────

export interface FileRuntimeStoreOpts {
  builtinDir: string;
  userDir: string;
  projectDir?: string;
}

export class FileRuntimeStore implements RuntimeStore {
  private builtinDir: string;
  private userDir: string;
  private projectDir?: string;

  constructor(opts: FileRuntimeStoreOpts) {
    this.builtinDir = opts.builtinDir;
    this.userDir = opts.userDir;
    this.projectDir = opts.projectDir;
  }

  get(name: string): RuntimeDefinition | null {
    // Normalise legacy names (claude, agent-sdk) to their post-rename equivalents
    // so old session rows + agent YAMLs continue to resolve. This is a single
    // Map lookup -- effectively free in the hot path.
    const resolved = RUNTIME_NAME_ALIASES[name] ?? name;

    // Resolution order: project > user > builtin
    const dirs: [string, RuntimeDefinition["_source"]][] = [];
    if (this.projectDir) dirs.push([this.projectDir, "project"]);
    dirs.push([this.userDir, "global"], [this.builtinDir, "builtin"]);

    for (const [dir, source] of dirs) {
      const path = join(dir, `${resolved}.yaml`);
      if (existsSync(path)) {
        const raw = YAML.parse(readFileSync(path, "utf-8")) ?? {};
        return { ...raw, _source: source, _path: path } as RuntimeDefinition;
      }
    }
    return null;
  }

  list(): RuntimeDefinition[] {
    const result = new Map<string, RuntimeDefinition>();

    const dirs: [string, RuntimeDefinition["_source"]][] = [
      [this.builtinDir, "builtin"],
      [this.userDir, "global"],
    ];
    if (this.projectDir) dirs.push([this.projectDir, "project"]);

    for (const [dir, source] of dirs) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
        const raw = YAML.parse(readFileSync(join(dir, file), "utf-8")) ?? {};
        const name = (raw.name as string) ?? file.replace(".yaml", "");
        result.set(name, { ...raw, name, _source: source, _path: join(dir, file) } as RuntimeDefinition);
      }
    }
    return [...result.values()];
  }

  save(name: string, def: RuntimeDefinition, scope: "global" | "project" = "global"): void {
    const dir = scope === "project" && this.projectDir ? this.projectDir : this.userDir;
    mkdirSync(dir, { recursive: true });
    const { _source, _path, ...data } = def;
    writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(data));
  }

  delete(name: string, scope: "global" | "project" = "global"): boolean {
    const dir = scope === "project" && this.projectDir ? this.projectDir : this.userDir;
    const path = join(dir, `${name}.yaml`);
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
    return false;
  }
}
