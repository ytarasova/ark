/**
 * Agent registry - template resolution and claude CLI args.
 *
 * Agent definitions are YAML files with: model, system prompt, tools,
 * MCP servers, skills, memories, context files.
 *
 * CRUD operations are on the AgentStore (app.agents). This module provides
 * template resolution and CLI argument building.
 */

import { existsSync } from "fs";
import { join, dirname } from "path";
import { substituteVars, buildSessionVars } from "./template.js";
import type { AppContext } from "./app.js";

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

// ── Template substitution ───────────────────────────────────────────────────

export function resolveAgent(app: AppContext, name: string, session: Record<string, unknown>, projectRoot?: string): AgentDefinition | null {
  const agent = app.agents.get(name, projectRoot);
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
  projectRoot?: string;
  app?: AppContext;
}): string[] {
  let systemPrompt = agent.system_prompt;

  // Inject skill prompts into system prompt
  if (agent.skills?.length && opts?.app) {
    const skillPrompts = agent.skills
      .map((name: string) => opts.app!.skills.get(name, opts?.projectRoot))
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
