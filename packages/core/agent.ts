/**
 * Agent registry - load, validate, template, build claude CLI args.
 *
 * Agent definitions are YAML files with: model, system prompt, tools,
 * MCP servers, skills, memories, context files.
 *
 * Supports Pi-style SKILL.md discovery and prompt templates.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { ARK_DIR } from "./store.js";

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
  _source?: "builtin" | "user";
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
const USER_DIR = join(ARK_DIR, "agents");

// ── Loading ─────────────────────────────────────────────────────────────────

export function loadAgent(name: string): AgentDefinition | null {
  for (const [dir, source] of [[USER_DIR, "user"], [BUILTIN_DIR, "builtin"]] as const) {
    const path = join(dir, `${name}.yaml`);
    if (existsSync(path)) {
      const raw = YAML.parse(readFileSync(path, "utf-8")) ?? {};
      return { ...DEFAULTS, ...raw, _source: source, _path: path } as AgentDefinition;
    }
  }
  return null;
}

export function listAgents(): AgentDefinition[] {
  const agents = new Map<string, AgentDefinition>();

  for (const [dir, source] of [[BUILTIN_DIR, "builtin"], [USER_DIR, "user"]] as const) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
      const raw = YAML.parse(readFileSync(join(dir, file), "utf-8")) ?? {};
      const name = raw.name ?? file.replace(".yaml", "");
      agents.set(name, { ...DEFAULTS, ...raw, name, _source: source, _path: join(dir, file) });
    }
  }
  return [...agents.values()];
}

export function saveAgent(agent: AgentDefinition): void {
  mkdirSync(USER_DIR, { recursive: true });
  const { _source, _path, ...data } = agent;
  writeFileSync(join(USER_DIR, `${agent.name}.yaml`), YAML.stringify(data));
}

export function deleteAgent(name: string): boolean {
  const path = join(USER_DIR, `${name}.yaml`);
  if (existsSync(path)) { unlinkSync(path); return true; }
  return false;
}

// ── Template substitution ───────────────────────────────────────────────────

export function resolveAgent(name: string, session: Record<string, unknown>): AgentDefinition | null {
  const agent = loadAgent(name);
  if (!agent) return null;

  const vars: Record<string, string> = {
    ticket: String(session.ticket ?? ""),
    summary: String(session.summary ?? ""),
    // Backward compat: agent YAML templates may still use {jira_key}/{jira_summary}
    jira_key: String(session.ticket ?? ""),
    jira_summary: String(session.summary ?? ""),
    repo: String(session.repo ?? ""),
    branch: String(session.branch ?? ""),
    workdir: String(session.workdir ?? "."),
    track_id: String(session.id ?? ""),
    stage: String(session.stage ?? ""),
  };

  if (agent.system_prompt) {
    agent.system_prompt = agent.system_prompt.replace(
      /\{(\w+)\}/g,
      (_, key) => vars[key] ?? `{${key}}`,
    );
  }
  return agent;
}

// ── Build claude CLI args ───────────────────────────────────────────────────

const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

export function buildClaudeArgs(agent: AgentDefinition, opts?: {
  task?: string;
  sessionId?: string;
  headless?: boolean;
}): string[] {
  const args = ["claude"];

  // Headless: -p with stream-json, skips trust prompt
  if (opts?.headless && opts.task) {
    args.push("-p", opts.task, "--verbose", "--output-format", "stream-json",
      "--dangerously-skip-permissions");
  }

  // Resume existing Claude session (handoff)
  if (opts?.sessionId) {
    args.push("--session-id", opts.sessionId);
  }

  // Model
  const model = MODEL_MAP[agent.model] ?? agent.model;
  if (model) args.push("--model", model);

  // Max turns
  if (agent.max_turns) args.push("--max-turns", String(agent.max_turns));

  // System prompt
  if (agent.system_prompt) args.push("--append-system-prompt", agent.system_prompt);

  // Permissions (only in interactive mode)
  if (!opts?.headless) {
    args.push("--dangerously-skip-permissions");
  }

  // MCP servers
  for (const mcp of agent.mcp_servers) {
    if (typeof mcp === "object") {
      args.push("--mcp-config", JSON.stringify(mcp));
    } else {
      args.push("--mcp-config", mcp);
    }
  }

  return args;
}

// ── Channel MCP config ──────────────────────────────────────────────────────

export function channelMcpConfig(sessionId: string, stage: string, channelPort: number): Record<string, unknown> {
  // Use absolute path to bun - it's not in PATH when Claude spawns MCP servers
  const bunPath = join(homedir(), ".bun", "bin", "bun");
  return {
    command: bunPath,
    args: [join(__dirname, "channel.ts")],
    env: {
      ARK_SESSION_ID: sessionId,
      ARK_STAGE: stage,
      ARK_CHANNEL_PORT: String(channelPort),
    },
  };
}
