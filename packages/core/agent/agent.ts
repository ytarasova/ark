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
  /**
   * Per-runtime-type configuration block. Keys are runtime types (`goose`,
   * `claude-code`, `claude-agent`, ...). Each runtime's executor reads ONLY
   * its own entry. Use this for fields that don't generalize across runtimes
   * (goose recipe paths, agent-sdk-only knobs, ...) so adding a new runtime
   * never requires editing the core AgentDefinition shape.
   *
   *   runtime_config:
   *     goose:
   *       recipe: "{inputs.files.recipe}"
   *       sub_recipes: ["{inputs.files.sub}"]
   */
  runtime_config?: Record<string, Record<string, unknown>>;
  /**
   * Per-runtime field overrides. Keyed by runtime name (e.g. `agent-sdk`,
   * `claude`, `gemini`). After the dispatch runtime is resolved, the matching
   * override block is shallow-merged onto the agent definition (override
   * fields replace base fields wholesale; arrays/objects are NOT deep-merged).
   *
   * Use cases: agent-sdk doesn't have the conductor `report` tool, so the
   * worker agent's CC system_prompt (which instructs the agent to call
   * `report(completed)`) needs an agent-sdk variant that uses transcript-and-
   * exit semantics instead.
   */
  runtime_overrides?: Record<string, Partial<Omit<AgentDefinition, "name" | "runtime_overrides">>>;
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
  // Agents may reference session inputs in runtime-specific paths, e.g.
  // `runtime_config.goose.recipe: "{inputs.files.recipe}"`. Resolve string
  // values inside `runtime_config` at agent-load time so the executor sees
  // concrete filesystem paths. Walks one level into each runtime block;
  // arrays of strings are substituted element-wise. Non-string leaves pass
  // through untouched -- runtimes that store numbers / objects keep them.
  if (agent.runtime_config) {
    for (const runtimeKey of Object.keys(agent.runtime_config)) {
      const block = agent.runtime_config[runtimeKey];
      if (!block || typeof block !== "object") continue;
      for (const k of Object.keys(block)) {
        const v = block[k];
        if (typeof v === "string") {
          block[k] = substituteVars(v, vars);
        } else if (Array.isArray(v)) {
          block[k] = v.map((item) => (typeof item === "string" ? substituteVars(item, vars) : item));
        }
      }
    }
  }
  return agent;
}

// ── Inline agents ───────────────────────────────────────────────────────────

import type { InlineAgentSpec } from "../state/flow.js";

/**
 * Build an AgentDefinition from an inline spec (e.g. from a stage's `agent:`
 * object) without touching the agent store. Applies the same template
 * substitution + runtime merge that `resolveAgentWithRuntime` does for named
 * agents, so inline agents behave identically downstream.
 *
 * Returns null if the spec is missing required fields (runtime, system_prompt).
 */
export function buildInlineAgent(
  app: AppContext,
  spec: InlineAgentSpec,
  session: Record<string, unknown>,
  opts?: { runtimeOverride?: string },
): AgentDefinition | null {
  if (!spec.runtime || !spec.system_prompt) return null;

  const vars = buildSessionVars(session);
  const agent: AgentDefinition = {
    name: spec.name ?? "inline",
    description: spec.description ?? "",
    model: spec.model ?? "sonnet",
    max_turns: spec.max_turns ?? 200,
    system_prompt: substituteVars(spec.system_prompt, vars),
    tools: spec.tools ?? ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    mcp_servers: spec.mcp_servers ?? [],
    skills: spec.skills ?? [],
    memories: spec.memories ?? [],
    context: spec.context ?? [],
    permission_mode: spec.permission_mode ?? "bypassPermissions",
    env: spec.env ?? {},
    runtime: spec.runtime,
    command: spec.command,
    task_delivery: spec.task_delivery,
    _source: "builtin",
  };

  // Apply the same runtime merge that resolveAgentWithRuntime does for named
  // agents, so inline agents get _resolved_runtime_type + runtime env etc.
  const runtimeName = opts?.runtimeOverride ?? agent.runtime;
  if (runtimeName) {
    const runtime = app.runtimes.get(runtimeName);
    if (runtime) {
      agent._resolved_runtime_type = runtime.type;
      if (!agent.command && runtime.command) agent.command = runtime.command;
      if (!agent.task_delivery && runtime.task_delivery) agent.task_delivery = runtime.task_delivery;
      if (runtime.env) agent.env = { ...runtime.env, ...agent.env };
    }
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

  // Apply per-runtime field overrides BEFORE template re-substitution so the
  // override's system_prompt is also processed for {{vars}}. We merge against
  // the dispatch runtime name (what actually gets used), not the agent's
  // declared default. Overrides are shallow-merged: the override's value
  // wholesale replaces the base's. Useful when an agent's CC-specific prompt
  // assumes tools (e.g. `report`) that other runtimes don't have.
  if (runtimeName && agent.runtime_overrides && agent.runtime_overrides[runtimeName]) {
    const override = agent.runtime_overrides[runtimeName];
    Object.assign(agent, override);
    if (override.system_prompt) {
      const vars = buildSessionVars(session);
      agent.system_prompt = substituteVars(override.system_prompt, vars);
    }
  }

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

  // Model selection: the agent owns its `model` field verbatim. The
  // ModelStore + resolveStage pipeline later turns it into a concrete
  // provider slug via the catalog. Runtimes no longer carry a model list
  // or a default_model fallback; absence of `agent.model` is a hard error
  // at resolve time.
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

  // Autonomous mode: override question-asking behavior
  if (opts?.autonomy === "full") {
    systemPrompt +=
      "\n\n## Autonomous Mode\nYou are running in FULLY AUTONOMOUS mode. Do NOT call report with type='question'. Do NOT wait for human input. Make your own decisions on any ambiguities and proceed directly to completion. Document your decisions in your output for later review.";
  }

  // Completion contract: the agent MUST signal it is done via the channel
  // `report` tool or its exit is silent -- the dashboard stays on "running",
  // flow routing never advances, and Stop-hook status reports don't carry a
  // summary. Make this the last thing before stopping so it cannot be
  // forgotten or deferred.
  systemPrompt +=
    "\n\n## Completion contract\n" +
    "Before you stop for any reason, you MUST call the `report` tool (from the `ark-channel` MCP server). This is non-negotiable -- your turn is not complete until that call has been made.\n\n" +
    "- Finished the task: call `report` with `type='completed'` and a summary of what changed (include `filesChanged`, `commits`, and `pr_url` when applicable).\n" +
    "- Blocked and need a human: call `report` with `type='question'` and the question.\n" +
    "- Hit an unrecoverable error: call `report` with `type='error'` and the failure reason.\n\n" +
    "Do NOT end your turn by only writing a chat message -- write the chat message, then call `report`. If you already reported progress earlier, you still must send the terminal report (`completed` / `question` / `error`) as your final tool call.";

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
