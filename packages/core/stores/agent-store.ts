/**
 * AgentStore - interface + file-backed implementation for agent definitions.
 *
 * Replaces the free functions in agent.ts that read from the filesystem via
 * global state (ARK_DIR). Consumers receive an AgentStore from AppContext
 * and call store methods instead.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { AgentDefinition } from "../agent/agent.js";

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS: Omit<AgentDefinition, "name"> = {
  description: "",
  model: "sonnet",
  max_turns: 200,
  system_prompt: "",
  tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  mcp_servers: [],
  skills: [],
  memories: [],
  context: [],
  permission_mode: "bypassPermissions",
  env: {},
  runtime: undefined,
  command: undefined,
  task_delivery: undefined,
};

// ── Types ───────────────────────────────────────────────────────────────────

export interface AgentStore {
  list(projectRoot?: string): AgentDefinition[];
  get(name: string, projectRoot?: string): AgentDefinition | null;
  save(name: string, agent: AgentDefinition, scope?: "global" | "project", projectRoot?: string): void;
  delete(name: string, scope?: "global" | "project", projectRoot?: string): boolean;
}

// ── File-backed implementation ──────────────────────────────────────────────

export interface FileAgentStoreOpts {
  builtinDir: string;
  userDir: string;
  projectDir?: string;
}

export class FileAgentStore implements AgentStore {
  private builtinDir: string;
  private userDir: string;
  private projectDir?: string;

  constructor(opts: FileAgentStoreOpts) {
    this.builtinDir = opts.builtinDir;
    this.userDir = opts.userDir;
    this.projectDir = opts.projectDir;
  }

  get(name: string, projectRoot?: string): AgentDefinition | null {
    const dirs: [string, AgentDefinition["_source"]][] = [];
    const projDir = projectRoot ? join(projectRoot, ".ark", "agents") : this.projectDir;
    if (projDir) dirs.push([projDir, "project"]);
    dirs.push([this.userDir, "global"], [this.builtinDir, "builtin"]);

    for (const [dir, source] of dirs) {
      const path = join(dir, `${name}.yaml`);
      if (existsSync(path)) {
        const raw = YAML.parse(readFileSync(path, "utf-8")) ?? {};
        return { ...DEFAULTS, ...raw, _source: source, _path: path } as AgentDefinition;
      }
    }
    return null;
  }

  list(projectRoot?: string): AgentDefinition[] {
    const agents = new Map<string, AgentDefinition>();
    const dirs: [string, AgentDefinition["_source"]][] = [
      [this.builtinDir, "builtin"],
      [this.userDir, "global"],
    ];
    const projDir = projectRoot ? join(projectRoot, ".ark", "agents") : this.projectDir;
    if (projDir) dirs.push([projDir, "project"]);

    for (const [dir, source] of dirs) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
        const raw = YAML.parse(readFileSync(join(dir, file), "utf-8")) ?? {};
        const name = raw.name ?? file.replace(".yaml", "");
        agents.set(name, { ...DEFAULTS, ...raw, name, _source: source, _path: join(dir, file) });
      }
    }
    return [...agents.values()];
  }

  save(name: string, agent: AgentDefinition, scope: "global" | "project" = "global", projectRoot?: string): void {
    const projDir = projectRoot ? join(projectRoot, ".ark", "agents") : this.projectDir;
    const dir = scope === "project" && projDir ? projDir : this.userDir;
    mkdirSync(dir, { recursive: true });
    const { _source, _path, ...data } = agent;
    writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(data));
  }

  delete(name: string, scope: "global" | "project" = "global", projectRoot?: string): boolean {
    const projDir = projectRoot ? join(projectRoot, ".ark", "agents") : this.projectDir;
    const dir = scope === "project" && projDir ? projDir : this.userDir;
    const path = join(dir, `${name}.yaml`);
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
    return false;
  }
}

/**
 * Validate that an agent definition carries a resolvable runtime field.
 * Dispatch paths MUST call this before using the agent definition.
 * Returns null on success, or an error message string on failure.
 */
export function validateAgentRuntime(agent: AgentDefinition): string | null {
  if (!agent.runtime || agent.runtime.trim() === "") {
    return `Agent '${agent.name}' has no runtime field -- every dispatched agent must declare a runtime`;
  }
  return null;
}
