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
import { ARK_DIR } from "./store.js";
import { substituteVars, buildSessionVars } from "./template.js";

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
};

// ── Paths ───────────────────────────────────────────────────────────────────

import { fileURLToPath } from "url";
import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "..", "..", "agents");
function GLOBAL_DIR() { return join(ARK_DIR(), "agents"); }

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

// ── Loading ─────────────────────────────────────────────────────────────────

export function loadAgent(name: string, projectRoot?: string): AgentDefinition | null {
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

export function listAgents(projectRoot?: string): AgentDefinition[] {
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

export function saveAgent(agent: AgentDefinition, scope: "project" | "global" = "global", projectRoot?: string): void {
  const dir = scope === "project" && projectRoot ? PROJECT_DIR(projectRoot) : GLOBAL_DIR();
  mkdirSync(dir, { recursive: true });
  const { _source, _path, ...data } = agent;
  writeFileSync(join(dir, `${agent.name}.yaml`), YAML.stringify(data));
}

export function deleteAgent(name: string, scope: "project" | "global" = "global", projectRoot?: string): boolean {
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

export function buildClaudeArgs(agent: AgentDefinition, opts?: {
  task?: string;
  sessionId?: string;
  headless?: boolean;
  autonomy?: string;
}): string[] {
  return claude.buildArgs({
    model: agent.model,
    maxTurns: agent.max_turns,
    systemPrompt: agent.system_prompt,
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
