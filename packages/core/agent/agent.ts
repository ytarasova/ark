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
import { substituteVars, buildSessionVars } from "../template.js";
import type { AppContext } from "../app.js";

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
  /** Resolved runtime type (claude-code, cli-agent, subprocess). Set by resolveAgentWithRuntime. */
  _resolved_runtime_type?: string;
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

export function resolveAgent(
  app: AppContext,
  name: string,
  session: Record<string, unknown>,
  projectRoot?: string,
): AgentDefinition | null {
  const agent = app.agents.get(name, projectRoot);
  if (!agent) return null;

  const vars = buildSessionVars(session);
  if (agent.system_prompt) {
    agent.system_prompt = substituteVars(agent.system_prompt, vars);
  }
  return agent;
}

// ── Runtime resolution ──────────────────────────────────────────────────────

/**
 * Resolve an agent and merge its runtime definition.
 *
 * If `runtimeOverride` is provided it takes priority over the agent's `runtime` field.
 * The resolved runtime's type, command, task_delivery, env, and permission_mode are
 * merged into the returned agent definition (agent-level values win where both exist).
 */
export function resolveAgentWithRuntime(
  app: AppContext,
  name: string,
  session: Record<string, unknown>,
  opts?: { runtimeOverride?: string; projectRoot?: string },
): AgentDefinition | null {
  const agent = resolveAgent(app, name, session, opts?.projectRoot);
  if (!agent) return null;

  const runtimeName = opts?.runtimeOverride ?? agent.runtime;
  if (!runtimeName) {
    // No runtime specified -- legacy behavior: use agent.runtime field as executor type
    return agent;
  }

  const runtime = app.runtimes.get(runtimeName);
  if (!runtime) {
    // Runtime name specified but not found -- fall back to using it as executor type (backward compat)
    return agent;
  }

  // Merge runtime config into agent (agent-level values take precedence)
  agent._resolved_runtime_type = runtime.type;

  // command: runtime provides default, agent can override
  if (!agent.command && runtime.command) {
    agent.command = runtime.command;
  }

  // task_delivery: runtime provides default, agent can override
  if (!agent.task_delivery && runtime.task_delivery) {
    agent.task_delivery = runtime.task_delivery;
  }

  // permission_mode: agent always wins if set; otherwise runtime default
  if (agent.permission_mode === "bypassPermissions" && runtime.permission_mode) {
    // Only override if agent uses the generic default
    // In practice, agents set this explicitly, so this is mainly for
    // cases where a runtime has specific permission requirements
  }

  // env: runtime env is base, agent env overrides
  if (runtime.env) {
    agent.env = { ...runtime.env, ...agent.env };
  }

  // model: only apply runtime default when the agent uses a generic alias
  // (opus/sonnet/haiku) that doesn't map to a real model ID on this runtime.
  // Custom model IDs set by the user (e.g. "MiniMax-M2.5") are always respected.
  if (runtime.models && runtime.models.length > 0 && runtime.default_model) {
    const GENERIC_ALIASES = ["opus", "sonnet", "haiku"];
    const validModels = runtime.models.map((m) => m.id);
    if (GENERIC_ALIASES.includes(agent.model) && !validModels.includes(agent.model)) {
      agent.model = runtime.default_model;
    }
  }

  return agent;
}

// ── Build claude CLI args ───────────────────────────────────────────────────

import * as claude from "../claude/claude.js";

export function buildClaudeArgs(
  agent: AgentDefinition,
  opts?: {
    task?: string;
    sessionId?: string;
    headless?: boolean;
    autonomy?: string;
    projectRoot?: string;
    app?: AppContext;
  },
): string[] {
  let systemPrompt = agent.system_prompt;

  // Tool hints: tell the agent what's available so it doesn't probe around.
  // Runs regardless of autonomy -- the permissions.allow list is defense-in-depth
  // but hints are how the agent actually knows what to call.
  const toolHints = claude.buildToolHints({ tools: agent.tools, mcp_servers: agent.mcp_servers });
  if (toolHints) {
    systemPrompt += "\n\n" + toolHints;
  }

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
