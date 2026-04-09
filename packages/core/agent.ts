/**
 * Agent registry - load, validate, template, build claude CLI args.
 *
 * Agent definitions are YAML files with: model, system prompt, tools,
 * MCP servers, skills, memories, context files.
 *
 * Supports Pi-style SKILL.md discovery and prompt templates.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { substituteVars, buildSessionVars } from "./template.js";
import { getApp } from "./app.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AgentDefinition {
  name: string;
  description: string;
  model: string;
  max_turns: number;
  system_prompt: string;
  tools: string[];
  mcp_servers: (string | Record<string, unknown>)[];
  skills: string[];
  memories: string[];
  context: string[];
  permission_mode: string;
  env: Record<string, string>;
  runtime?: string;
  command?: string[];
  task_delivery?: "stdin" | "file" | "arg";
  _source?: "builtin" | "global" | "project";
  _path?: string;
}

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

// ── Paths ───────────────────────────────────────────────────────────────────

import { fileURLToPath } from "url";
import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "..", "..", "agents");
function GLOBAL_DIR() { return join(getApp().config.arkDir, "agents"); }

/** Walk up from cwd looking for .git/ to find project root. */
export function findProjectRoot(cwd?: string): string | null {
  let dir = cwd ?? process.cwd();
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function PROJECT_DIR(root: string) { return join(root, ".ark", "agents"); }

// ── Loading (backward-compat wrappers delegating to AppContext stores) ──────

/** @deprecated Use app.agents.get(name, projectRoot) instead */
export function loadAgent(name: string, projectRoot?: string): AgentDefinition | null {
  try { return getApp().agents.get(name, projectRoot); } catch {
    // Fallback for cases where AppContext is not booted
    const dirs: [string, AgentDefinition["_source"]][] = [];
    if (projectRoot) dirs.push([PROJECT_DIR(projectRoot), "project"]);
    dirs.push([GLOBAL_DIR(), "global"], [BUILTIN_DIR, "builtin"]);

    for (const [dir, source] of dirs) {
      const path = join(dir, `${name}.yaml`);
      if (existsSync(path)) {
        const raw = YAML.parse(readFileSync(path, "utf-8")) ?? {};
        return { ...DEFAULTS, ...raw, _source: source, _path: path } as AgentDefinition;
      }
    }
    return null;
  }
}

/** @deprecated Use app.agents.list(projectRoot) instead */
export function listAgents(projectRoot?: string): AgentDefinition[] {
  try { return getApp().agents.list(projectRoot); } catch {
    // Fallback for cases where AppContext is not booted
    const agents = new Map<string, AgentDefinition>();
    const dirs: [string, AgentDefinition["_source"]][] = [
      [BUILTIN_DIR, "builtin"],
      [GLOBAL_DIR(), "global"],
    ];
    if (projectRoot) dirs.push([PROJECT_DIR(projectRoot), "project"]);

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
}

/** @deprecated Use app.agents.save(name, agent, scope, projectRoot) instead */
export function saveAgent(agent: AgentDefinition, scope: "project" | "global" = "global", projectRoot?: string): void {
  try {
    getApp().agents.save(agent.name, agent, scope, projectRoot);
    return;
  } catch { /* fallback */ }
  const dir = scope === "project" && projectRoot ? PROJECT_DIR(projectRoot) : GLOBAL_DIR();
  mkdirSync(dir, { recursive: true });
  const { _source, _path, ...data } = agent;
  writeFileSync(join(dir, `${agent.name}.yaml`), YAML.stringify(data));
}

/** @deprecated Use app.agents.delete(name, scope, projectRoot) instead */
export function deleteAgent(name: string, scope: "project" | "global" = "global", projectRoot?: string): boolean {
  try { return getApp().agents.delete(name, scope, projectRoot); } catch { /* fallback */ }
  const dir = scope === "project" && projectRoot ? PROJECT_DIR(projectRoot) : GLOBAL_DIR();
  const path = join(dir, `${name}.yaml`);
  if (existsSync(path)) { unlinkSync(path); return true; }
  return false;
}

// ── Template substitution ───────────────────────────────────────────────────

export function resolveAgent(name: string, session: Record<string, unknown>, projectRoot?: string): AgentDefinition | null {
  const agent = loadAgent(name, projectRoot);
  if (!agent) return null;

  const vars = buildSessionVars(session);
  if (agent.system_prompt) {
    agent.system_prompt = substituteVars(agent.system_prompt, vars);
  }
  return agent;
}

// ── Build claude CLI args ───────────────────────────────────────────────────

import * as claude from "./claude.js";
import { loadSkill } from "./skill.js";

export function buildClaudeArgs(agent: AgentDefinition, opts?: {
  task?: string;
  sessionId?: string;
  headless?: boolean;
  autonomy?: string;
  projectRoot?: string;
}): string[] {
  let systemPrompt = agent.system_prompt;

  // Inject skill prompts into system prompt
  if (agent.skills?.length) {
    const skillPrompts = agent.skills
      .map((name: string) => loadSkill(name, opts?.projectRoot))
      .filter(Boolean)
      .map((s: any) => `## Skill: ${s.name}\n${s.prompt}`);
    if (skillPrompts.length) {
      systemPrompt += "\n\n" + skillPrompts.join("\n\n");
    }
  }

  return claude.buildArgs({
    model: agent.model,
    maxTurns: agent.max_turns,
    systemPrompt,
    mcpServers: agent.mcp_servers,
    task: opts?.task,
    sessionId: opts?.sessionId,
    headless: opts?.headless,
    autonomy: opts?.autonomy,
  });
}

export function channelMcpConfig(sessionId: string, stage: string, channelPort: number): Record<string, unknown> {
  return claude.channelMcpConfig(sessionId, stage, channelPort);
}
