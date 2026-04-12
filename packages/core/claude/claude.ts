/**
 * Claude CLI integration -- model mapping, argument building, trust management,
 * channel config, launcher generation, and prompt auto-accept.
 *
 * All Claude-specific knowledge lives here so session.ts and agent.ts
 * stay domain-focused.
 */

import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, renameSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

import * as tmux from "../infra/tmux.js";
import { DEFAULT_CONDUCTOR_URL, DEFAULT_CHANNEL_BASE_URL } from "../constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Model mapping ────────────────────────────────────────────────────────────

export const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

export function resolveModel(short: string): string {
  return MODEL_MAP[short] ?? short;
}

// ── CLI argument building ────────────────────────────────────────────────────

export interface ClaudeArgsOpts {
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  tools?: string[];
  mcpServers?: (string | Record<string, unknown>)[];
  task?: string;
  sessionId?: string;
  headless?: boolean;
  autonomy?: string;
}

export function buildArgs(opts: ClaudeArgsOpts): string[] {
  const args = ["claude"];
  const skipPerms = !opts.autonomy || opts.autonomy === "full" || opts.autonomy === "execute";

  if (opts.headless && opts.task) {
    args.push("-p", opts.task, "--verbose", "--output-format", "stream-json");
    if (skipPerms) {
      args.push("--dangerously-skip-permissions");
    }
  }

  if (opts.sessionId) {
    args.push("--session-id", opts.sessionId);
  }

  const model = opts.model ? resolveModel(opts.model) : null;
  if (model) args.push("--model", model);

  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);

  if (!opts.headless) {
    if (skipPerms) {
      args.push("--dangerously-skip-permissions");
    }
  }

  for (const mcp of opts.mcpServers ?? []) {
    if (typeof mcp === "object") {
      args.push("--mcp-config", JSON.stringify(mcp));
    } else {
      args.push("--mcp-config", mcp);
    }
  }

  return args;
}

// ── Shell quoting ────────────────────────────────────────────────────────────

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Quote CLI args for bash, preserving --flags unquoted. */
export function shellQuoteArgs(claudeArgs: string[]): string {
  return claudeArgs.map((arg, i) => {
    if (arg.startsWith("--")) return arg;
    const prev = claudeArgs[i - 1];
    if (prev && prev.startsWith("--")) return shellQuote(arg);
    return arg;
  }).join(" ");
}

// ── Channel MCP config ──────────────────────────────────────────────────────

export function channelMcpConfig(
  sessionId: string, stage: string, channelPort: number,
  opts?: { conductorUrl?: string; tenantId?: string },
): Record<string, unknown> {
  const bunPath = join(homedir(), ".bun", "bin", "bun");
  const env: Record<string, string> = {
    ARK_SESSION_ID: sessionId,
    ARK_STAGE: stage,
    ARK_CHANNEL_PORT: String(channelPort),
    ARK_CONDUCTOR_URL: opts?.conductorUrl ?? DEFAULT_CONDUCTOR_URL,
  };
  if (opts?.tenantId) env.ARK_TENANT_ID = opts.tenantId;
  return {
    command: bunPath,
    args: [join(__dirname, "channel.ts")],
    env,
  };
}

/**
 * Write channel MCP config to the worktree's .mcp.json.
 * Claude Code reads .mcp.json from the project directory at startup.
 * --dangerously-load-development-channels server:NAME looks up NAME
 * in the loaded MCP config, so the server must be in .mcp.json.
 */
export function writeChannelConfig(
  sessionId: string, stage: string, channelPort: number,
  workdir: string,
  opts?: { conductorUrl?: string; channelConfig?: Record<string, unknown>; tracksDir?: string },
): string {
  const config = opts?.channelConfig ?? channelMcpConfig(sessionId, stage, channelPort, { conductorUrl: opts?.conductorUrl });

  // Write to worktree .mcp.json so Claude finds it
  const mcpConfigPath = join(workdir, ".mcp.json");
  let existing: Record<string, any> = {};
  if (existsSync(mcpConfigPath)) {
    try { existing = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); }
    catch (e: any) { console.error(`writeChannelConfig: failed to parse ${mcpConfigPath}:`, e?.message ?? e); }
  }
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers["ark-channel"] = config;
  writeFileSync(mcpConfigPath, JSON.stringify(existing, null, 2));

  // Also write a copy to tracks dir for reference
  if (opts?.tracksDir) {
    const sessionDir = join(opts.tracksDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "mcp.json"), JSON.stringify({ mcpServers: { "ark-channel": config } }, null, 2));
  }

  return mcpConfigPath;
}

// ── Permissions from agent tools ────────────────────────────────────────────

export interface AgentToolSpec {
  tools?: string[];
  mcp_servers?: (string | Record<string, unknown>)[];
}

/** Extract the set of MCP server names the agent explicitly declares. */
function declaredMcpServers(agent: AgentToolSpec): Set<string> {
  const out = new Set<string>();
  for (const srv of agent.mcp_servers ?? []) {
    if (srv && typeof srv === "object") {
      for (const key of Object.keys(srv)) out.add(key);
    } else if (typeof srv === "string") {
      const base = srv.split("/").pop() ?? srv;
      out.add(base.replace(/\.json$/, ""));
    }
  }
  return out;
}

/** Extract server names referenced by explicit `mcp__<server>__<tool>` entries in agent.tools. */
function explicitMcpServerRefs(tools: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tools) {
    const parts = t.split("__");
    if (parts[0] === "mcp" && parts.length >= 3) out.add(parts[1]);
  }
  return out;
}

/**
 * Build a Claude Code `permissions.allow` list from an agent's tool + MCP declarations.
 *
 * Rules:
 *  1. Every entry in `agent.tools` is included as-is -- built-in names (Bash, Read, ...),
 *     explicit MCP entries (`mcp__atlassian__getJiraIssue`), or wildcards (`mcp__atlassian__*`).
 *  2. For each declared `mcp_servers` entry that has no explicit `mcp__<server>__` reference
 *     in `agent.tools`, an implicit `mcp__<server>__*` wildcard is appended so existing
 *     agents that only list servers keep working.
 *  3. Any `mcp__<server>__*` entry in `agent.tools` that references a server NOT declared
 *     in `agent.mcp_servers` is a configuration error and throws.
 */
export function buildPermissionsAllow(agent: AgentToolSpec): string[] {
  const tools = agent.tools ?? [];
  const declared = declaredMcpServers(agent);
  const explicit = explicitMcpServerRefs(tools);

  for (const name of explicit) {
    if (!declared.has(name)) {
      throw new Error(
        `Agent tool entry 'mcp__${name}__*' references MCP server '${name}' ` +
        `which is not declared in mcp_servers. Add '${name}' to mcp_servers or remove the tool entry.`,
      );
    }
  }

  const allow = [...tools];
  for (const name of declared) {
    if (!explicit.has(name)) allow.push(`mcp__${name}__*`);
  }
  return allow;
}

/**
 * Build a prompt-hint section telling the agent which tools and MCP servers
 * are available, so it does not waste turns probing or listing tools.
 *
 * This is the *primary* channel for `agent.tools` / `agent.mcp_servers` --
 * the settings.local.json `permissions.allow` list is defense-in-depth and
 * only takes effect when --dangerously-skip-permissions is off. The prompt
 * hint runs in every dispatch regardless of autonomy.
 */
export function buildToolHints(agent: AgentToolSpec): string {
  const tools = agent.tools ?? [];
  const declared = declaredMcpServers(agent);

  if (tools.length === 0 && declared.size === 0) return "";

  const builtinNames = tools.filter((t) => !t.startsWith("mcp__"));
  const explicitMcpTools = tools.filter((t) => t.startsWith("mcp__") && !t.endsWith("__*"));

  const sections: string[] = ["## Available tools", ""];

  if (builtinNames.length > 0) {
    sections.push(`**Built-in:** ${builtinNames.join(", ")}`);
  }

  if (declared.size > 0) {
    const serverLines = [...declared].map((name) => `- \`${name}\` -- call via \`mcp__${name}__<toolName>\``);
    sections.push("", "**MCP servers:**", ...serverLines);
  }

  if (explicitMcpTools.length > 0) {
    sections.push("", `**Specific MCP tools granted:** ${explicitMcpTools.join(", ")}`);
  }

  sections.push(
    "",
    "Call these tools directly when the task requires them. Do not probe, list, or ask which tools exist -- the list above is authoritative.",
  );

  return sections.join("\n");
}

// ── Hook-based status config ────────────────────────────────────────────────

const ARK_HOOK_MARKER = "# ark-status";

function hookCommand(sessionId: string, conductorUrl: string, tenantId?: string): string {
  const tenantHeader = tenantId ? ` -H 'X-Ark-Tenant-Id: ${tenantId}'` : "";
  return `curl -sf -X POST -H 'Content-Type: application/json'${tenantHeader} -d @- '${conductorUrl}/hooks/status?session=${sessionId}' > /dev/null 2>&1 || true ${ARK_HOOK_MARKER}`;
}

function buildHooksConfig(sessionId: string, conductorUrl: string, tenantId?: string): Record<string, unknown[]> {
  const cmd = hookCommand(sessionId, conductorUrl, tenantId);
  const asyncHook = { type: "command" as const, command: cmd, async: true };
  const syncHook = { type: "command" as const, command: cmd, async: false };

  return {
    PreToolUse: [{ hooks: [syncHook] }],
    SessionStart: [{ matcher: "startup|resume", hooks: [asyncHook] }],
    UserPromptSubmit: [{ hooks: [asyncHook] }],
    Stop: [{ hooks: [asyncHook] }],
    StopFailure: [{ hooks: [asyncHook] }],
    SessionEnd: [{ hooks: [asyncHook] }],
    Notification: [{ matcher: "permission_prompt|idle_prompt", hooks: [asyncHook] }],
    PreCompact: [{ hooks: [asyncHook] }],
    PostCompact: [{ hooks: [asyncHook] }],
  };
}

/** Remove all ark-managed hook entries from a hooks object, mutating it in place. */
function filterOutArkHooks(hooks: Record<string, unknown[]>): void {
  for (const [event, matchers] of Object.entries(hooks)) {
    hooks[event] = matchers.filter((m) => {
      const matcher = m as { hooks?: Array<{ command?: string }> };
      return !matcher.hooks?.some((h) => h.command?.includes(ARK_HOOK_MARKER));
    });
    if (hooks[event].length === 0) delete hooks[event];
  }
}

export function writeHooksConfig(
  sessionId: string, conductorUrl: string, workdir: string,
  opts?: { autonomy?: string; agent?: AgentToolSpec; tenantId?: string },
): string {
  const claudeDir = join(workdir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.local.json");

  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, "utf-8")); }
    catch (e: any) { console.error(`writeHooksConfig: failed to parse ${settingsPath}:`, e?.message ?? e); }
  }

  // Remove previous ark hooks (idempotent)
  if (existing.hooks && typeof existing.hooks === "object") {
    filterOutArkHooks(existing.hooks as Record<string, unknown[]>);
    if (Object.keys(existing.hooks as object).length === 0) delete existing.hooks;
  }

  // Merge new hooks
  const newHooks = buildHooksConfig(sessionId, conductorUrl, opts?.tenantId);
  const existingHooks = (existing.hooks ?? {}) as Record<string, unknown[]>;
  for (const [event, matchers] of Object.entries(newHooks)) {
    existingHooks[event] = [...(existingHooks[event] ?? []), ...matchers];
  }
  existing.hooks = existingHooks;

  // Ark-managed state tracker
  const arkMeta = (existing._ark ?? {}) as Record<string, unknown>;

  // Build permissions.allow from agent.tools + declared mcp_servers (if agent provided).
  // autonomy=full / --dangerously-skip-permissions is the explicit override: when set,
  // Claude Code bypasses this list. The allow list is authoritative when bypass is off.
  if (opts?.agent && (opts.agent.tools?.length ?? 0) > 0) {
    const allow = buildPermissionsAllow(opts.agent);
    const perms = (existing.permissions ?? {}) as Record<string, unknown>;
    perms.allow = allow;
    existing.permissions = perms;
    arkMeta.managedAllow = true;
  }

  // Add permission restrictions based on autonomy level
  if (opts?.autonomy === "edit") {
    const perms = (existing.permissions ?? {}) as Record<string, unknown>;
    perms.deny = ["Bash"];
    existing.permissions = perms;
    arkMeta.managedDeny = true;
  } else if (opts?.autonomy === "read-only") {
    const perms = (existing.permissions ?? {}) as Record<string, unknown>;
    perms.deny = ["Bash", "Write", "Edit"];
    existing.permissions = perms;
    arkMeta.managedDeny = true;
  }

  if (Object.keys(arkMeta).length > 0) {
    existing._ark = arkMeta;
  }

  // Atomic write
  const tmpPath = settingsPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(existing, null, 2));
  renameSync(tmpPath, settingsPath);

  return settingsPath;
}

export function removeHooksConfig(workdir: string): void {
  const settingsPath = join(workdir, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) return;

  let settings: Record<string, unknown>;
  try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); }
  catch (e: any) { console.error(`removeHooksConfig: failed to parse ${settingsPath}:`, e?.message ?? e); return; }

  const arkMeta = (settings._ark ?? {}) as Record<string, unknown>;

  if (settings.hooks && typeof settings.hooks === "object") {
    filterOutArkHooks(settings.hooks as Record<string, unknown[]>);
    if (Object.keys(settings.hooks as object).length === 0) delete settings.hooks;
  }

  // Strip ark-managed permission entries, preserving anything the user added
  if (settings.permissions && typeof settings.permissions === "object") {
    const perms = settings.permissions as Record<string, unknown>;
    if (arkMeta.managedAllow) delete perms.allow;
    if (arkMeta.managedDeny) delete perms.deny;
    if (Object.keys(perms).length === 0) delete settings.permissions;
  }

  delete settings._ark;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ── Launcher script ─────────────────────────────────────────────────────────

export interface LauncherOpts {
  workdir: string;
  claudeArgs: string[];
  mcpConfigPath: string;
  claudeSessionId?: string;
  prevClaudeSessionId?: string | null;
  /** Session name for --remote-control flag */
  sessionName?: string;
  /** Environment variables to export before launching Claude */
  env?: Record<string, string>;
  /** Initial prompt passed as positional arg -- triggers immediate processing */
  initialPrompt?: string;
}

/** Generate launcher bash script content. */
export function buildLauncher(opts: LauncherOpts): { content: string; claudeSessionId: string } {
  const claudeSessionId = opts.claudeSessionId ?? randomUUID();
  const claudeCmd = shellQuoteArgs(opts.claudeArgs);
  // Channel + remote control flags
  // Channel config is in .mcp.json (project level), Claude reads it automatically
  const extraFlags = [
    `--dangerously-load-development-channels server:ark-channel`,
    `--remote-control ${shellQuote(opts.sessionName ?? "ark")}`,
  ].join(" \\\n  ");

  const envExports = Object.entries(opts.env ?? {})
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("\n");
  const envBlock = envExports ? envExports + "\n" : "";

  // Ensure tools are in PATH (claude, bun, nvm live in ~/.local/bin etc)
  // Can't source .bashrc -- it exits early for non-interactive shells
  const pathSetup = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.nvm/versions/node/*/bin:$PATH"\n`;

  // When initialPrompt is provided, append it as the last positional arg
  // to trigger immediate processing (claude "prompt" --session-id X).
  const promptArg = opts.initialPrompt ? ` \\\n  ${shellQuote(opts.initialPrompt)}` : "";

  let content: string;
  if (opts.prevClaudeSessionId) {
    content = `#!/bin/bash
${pathSetup}cd ${shellQuote(opts.workdir)}
${envBlock}${claudeCmd} --resume ${shellQuote(opts.prevClaudeSessionId)} \\
  ${extraFlags}${promptArg} || \\
${claudeCmd} --session-id ${shellQuote(claudeSessionId)} \\
  ${extraFlags}${promptArg}
exec bash
`;
  } else {
    content = `#!/bin/bash
${pathSetup}cd ${shellQuote(opts.workdir)}
${envBlock}${claudeCmd} --session-id ${shellQuote(claudeSessionId)} \\
  ${extraFlags}${promptArg}
exec bash
`;
  }

  return { content, claudeSessionId };
}

// ── Trust management ─────────────────────────────────────────────────────────

/** Pre-accept trust dialog and symlink project settings for a worktree. */
export function trustWorktree(originalRepo: string, worktreeDir: string): void {
  const projectsDir = join(homedir(), ".claude", "projects");
  const encode = (p: string) => resolve(p).replace(/\//g, "-").replace(/\./g, "-");

  const origProject = join(projectsDir, encode(originalRepo));
  const wtProject = join(projectsDir, encode(worktreeDir));

  if (existsSync(origProject) && !existsSync(wtProject)) {
    try { symlinkSync(origProject, wtProject); }
    catch (e: any) { console.error(`trustWorktree: failed to symlink ${origProject} -> ${wtProject}:`, e?.message ?? e); }
  }

  trustDirectory(worktreeDir);
}

/** Pre-accept trust dialog for a local directory. */
export function trustDirectory(dir: string): void {
  const claudeJsonPath = join(homedir(), ".claude.json");
  try {
    const claudeJson = existsSync(claudeJsonPath)
      ? JSON.parse(readFileSync(claudeJsonPath, "utf-8"))
      : {};
    if (!claudeJson.projects) claudeJson.projects = {};
    const resolvedPath = resolve(dir);
    if (!claudeJson.projects[resolvedPath]?.hasTrustDialogAccepted) {
      claudeJson.projects[resolvedPath] = {
        ...(claudeJson.projects[resolvedPath] ?? {}),
        hasTrustDialogAccepted: true,
      };
      writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
    }
  } catch (e: any) { console.error(`trustDirectory: failed to update ${claudeJsonPath}:`, e?.message ?? e); }
}

// ── Channel prompt auto-accept ───────────────────────────────────────────────

const CHANNEL_PROMPT_MARKERS = [
  "I am using this for local",
  "local channel development",
];
/** Indicators that Claude is past all prompts and actively working. */
const CLAUDE_WORKING_MARKERS = [
  "ctrl+o to expand",
  "esc to interrupt",
];

/**
 * Poll tmux pane for the channel development prompt and auto-accept it.
 *
 * The launcher may use `--resume <id> || --session-id <id>`, which causes
 * TWO Claude startups (and two channel prompts) when resume fails.
 * To handle this, we keep polling after acceptance until Claude is actually
 * working -- we don't return after the first accept.
 *
 * Four outcomes per poll:
 * 1. Prompt found → send "1" + Enter, keep polling for a second prompt
 * 2. No prompt and Claude is working (tool use visible) → done
 * 3. No prompt but previously accepted one → keep polling briefly
 * 4. Neither → keep polling (Claude still starting up)
 */
export async function autoAcceptChannelPrompt(
  tmuxName: string,
  opts?: { maxAttempts?: number; delayMs?: number },
): Promise<void> {
  const max = opts?.maxAttempts ?? 45;
  const delay = opts?.delayMs ?? 1000;
  let _accepted = 0;

  for (let i = 0; i < max; i++) {
    await Bun.sleep(delay);
    try {
      const output = await tmux.capturePaneAsync(tmuxName, { lines: 30 });

      // Found the prompt -- accept it and keep polling
      if (CHANNEL_PROMPT_MARKERS.some(m => output.includes(m))) {
        await tmux.sendKeysAsync(tmuxName, "1");
        await Bun.sleep(300);
        await tmux.sendKeysAsync(tmuxName, "Enter");
        _accepted++;
        continue;
      }

      // Claude is actively working -- safe to stop polling.
      // These only appear after Claude has fully started and is past any prompts.
      if (CLAUDE_WORKING_MARKERS.some(m => output.includes(m))) {
        return;
      }
    } catch { /* tmux pane may not exist yet during startup -- retry on next iteration */ }
  }
}

// ── Channel task delivery ────────────────────────────────────────────────────

const deliveryInFlight = new Map<string, boolean>();

/**
 * Deliver a task to a Claude session via channel.
 * Tries arkd delivery first, then falls back to direct HTTP with retry.
 */
export async function deliverTask(
  sessionId: string, channelPort: number,
  task: string, stage: string,
  opts?: { arkdUrl?: string },
): Promise<void> {
  if (deliveryInFlight.get(sessionId)) return;
  deliveryInFlight.set(sessionId, true);

  const payload = { type: "task", task, sessionId, stage };

  try {
    // Try arkd delivery first
    if (opts?.arkdUrl) {
      try {
        const { ArkdClient } = await import("../arkd/client.js");
        const client = new ArkdClient(opts.arkdUrl);
        const result = await client.channelDeliver({ channelPort, payload });
        if (result.delivered) return;
      } catch (e: any) {
        console.error(`deliverTask: arkd delivery failed for session ${sessionId}, falling back to direct:`, e?.message ?? e);
      }
    }

    // Fallback: direct HTTP to channel port with retry
    const url = `${DEFAULT_CHANNEL_BASE_URL}:${channelPort}`;
    for (let i = 0; i < 60; i++) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          return;
        }
      } catch { /* channel port not ready yet -- retry */ }
      await Bun.sleep(1000);
    }
  } finally {
    deliveryInFlight.delete(sessionId);
  }
}
