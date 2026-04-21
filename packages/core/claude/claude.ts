/**
 * Claude CLI integration -- model mapping, argument building, trust management,
 * channel config, launcher generation, and prompt auto-accept.
 *
 * All Claude-specific knowledge lives here so session.ts and agent.ts
 * stay domain-focused.
 */

import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, mkdirSync, renameSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

import * as tmux from "../infra/tmux.js";
import { DEFAULT_CONDUCTOR_URL, DEFAULT_CHANNEL_BASE_URL } from "../constants.js";
import { channelLaunchSpec } from "../install-paths.js";
import { findCodebaseMemoryBinary } from "../knowledge/codebase-memory-finder.js";
import { logInfo, logDebug } from "../observability/structured-log.js";

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
  return claudeArgs
    .map((arg, i) => {
      if (arg.startsWith("--")) return arg;
      const prev = claudeArgs[i - 1];
      if (prev && prev.startsWith("--")) return shellQuote(arg);
      return arg;
    })
    .join(" ");
}

// ── Channel MCP config ──────────────────────────────────────────────────────

export function channelMcpConfig(
  sessionId: string,
  stage: string,
  channelPort: number,
  opts?: { conductorUrl?: string; tenantId?: string },
): Record<string, unknown> {
  const env: Record<string, string> = {
    ARK_SESSION_ID: sessionId,
    ARK_STAGE: stage,
    ARK_CHANNEL_PORT: String(channelPort),
    ARK_CONDUCTOR_URL: opts?.conductorUrl ?? DEFAULT_CONDUCTOR_URL,
  };
  if (opts?.tenantId) env.ARK_TENANT_ID = opts.tenantId;
  // channelLaunchSpec() returns:
  //   compiled mode: { command: process.execPath, args: ["channel"] }
  //   dev mode:      { command: bun, args: [<repo>/packages/cli/index.ts, "channel"] }
  // This replaces the old `bun + CHANNEL_SCRIPT_PATH` approach which broke in
  // compiled binaries because channel.ts lived in Bun's virtual FS, not on disk.
  const spec = channelLaunchSpec();
  return {
    command: spec.command,
    args: spec.args,
    env,
  };
}

/**
 * Expand `${ENV_NAME}` and `${ENV_NAME:-default}` placeholders inside an
 * MCP server config against `process.env`. Used by runtime-level MCP
 * entries so a single YAML / JSON stub can be parameterised per
 * deployment (e.g. URLs, API tokens, sockets) with a shipped default.
 *
 * Walks objects/arrays recursively. Non-string leaves are left untouched.
 * Missing env vars without a default are left as the literal `${VAR}` so
 * the underlying MCP server can decide whether to error -- we don't want
 * to swallow misconfig silently here.
 */
export function expandEnvPlaceholders<T>(value: T, env: Record<string, string | undefined> = process.env): T {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (full, name, fallback) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== "") return resolved;
      if (fallback !== undefined) return fallback;
      return full;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvPlaceholders(v, env)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvPlaceholders(v, env);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Resolve an MCP server entry into a `{ name, config }` pair suitable for
 * writing into `.mcp.json["mcpServers"]`. Supports the same input shapes
 * as `RuntimeDefinition.mcp_servers` and `AgentDefinition.mcp_servers`:
 *   - string path to `<somewhere>/<name>.json` (loaded from disk; the file
 *     must contain `{"mcpServers": { "<name>": { ... } }}`)
 *   - bare server name like `"pi-sage"` -- looked up in `mcpConfigsDir` if
 *     supplied, otherwise treated as just a name with no config to add
 *   - inline object `{ "<name>": { command, args, env } | { type, url } }`
 * Returns `null` when the entry can't be resolved (file missing, etc.).
 */
function resolveMcpServerEntry(
  entry: string | Record<string, unknown>,
  opts?: { mcpConfigsDir?: string },
): { name: string; config: Record<string, unknown> } | null {
  if (typeof entry === "object" && entry !== null) {
    const keys = Object.keys(entry);
    if (keys.length !== 1) return null;
    const name = keys[0];
    const raw = entry[name];
    if (typeof raw !== "object" || raw === null) return null;
    return { name, config: expandEnvPlaceholders(raw as Record<string, unknown>) };
  }

  if (typeof entry !== "string") return null;

  // Determine candidate file path -- either explicit, or look up in mcpConfigsDir
  let filePath: string | null = null;
  let derivedName: string;
  if (entry.endsWith(".json") || entry.includes("/")) {
    filePath = resolve(entry);
    derivedName = (entry.split("/").pop() ?? entry).replace(/\.json$/, "");
  } else {
    derivedName = entry;
    if (opts?.mcpConfigsDir) {
      filePath = join(opts.mcpConfigsDir, `${entry}.json`);
    }
  }

  if (!filePath || !existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, Record<string, unknown>> | undefined;
    if (!servers) return null;
    // Prefer the entry whose key matches `derivedName`; fall back to the only entry.
    const match = servers[derivedName] ?? (Object.keys(servers).length === 1 ? servers[Object.keys(servers)[0]] : null);
    if (!match) return null;
    return { name: derivedName, config: expandEnvPlaceholders(match) };
  } catch (e: any) {
    console.error(`resolveMcpServerEntry: failed to load ${filePath}:`, e?.message ?? e);
    return null;
  }
}

/**
 * Write channel MCP config to the worktree's .mcp.json.
 * Claude Code reads .mcp.json from the project directory at startup.
 * --dangerously-load-development-channels server:NAME looks up NAME
 * in the loaded MCP config, so the server must be in .mcp.json.
 *
 * Merge order (later wins for the same name only via opt-in entries; the
 * channel + codebase-memory are always written last so they cannot be
 * shadowed by repo / runtime config):
 *   1. existing `.mcp.json` in the worktree
 *   2. servers copied from `originalRepoDir/.mcp.json` (skips `ark-channel`,
 *      never overwrites existing names)
 *   3. servers declared in the runtime YAML (`runtimeMcpServers`)
 *   4. `ark-channel` (always overwritten)
 *   5. `codebase-memory` (only if the binary is on disk and not already set)
 */
export function writeChannelConfig(
  sessionId: string,
  stage: string,
  channelPort: number,
  workdir: string,
  opts?: {
    conductorUrl?: string;
    channelConfig?: Record<string, unknown>;
    tracksDir?: string;
    originalRepoDir?: string;
    /** MCP servers declared on the active runtime YAML. */
    runtimeMcpServers?: (string | Record<string, unknown>)[];
    /** Directory holding `<name>.json` files referenced by string entries. */
    mcpConfigsDir?: string;
    /**
     * When true, additionally inject the unified `ark-code-intel` MCP server
     * alongside the legacy `codebase-memory` entry. Gated by
     * `config.features.codeIntelV2`. Wave 1 default: false.
     */
    enableCodeIntelV2?: boolean;
  },
): string {
  const config =
    opts?.channelConfig ?? channelMcpConfig(sessionId, stage, channelPort, { conductorUrl: opts?.conductorUrl });

  // Write to worktree .mcp.json so Claude finds it
  const mcpConfigPath = join(workdir, ".mcp.json");
  let existing: Record<string, any> = {};
  if (existsSync(mcpConfigPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
    } catch (e: any) {
      console.error(`writeChannelConfig: failed to parse ${mcpConfigPath}:`, e?.message ?? e);
    }
  }

  // Merge MCP servers from the original repo's .mcp.json into the worktree.
  // Git worktrees don't include untracked files like .mcp.json, so agents in
  // worktrees would lose access to MCP servers configured in the original repo.
  if (opts?.originalRepoDir && resolve(opts.originalRepoDir) !== resolve(workdir)) {
    const origMcpPath = join(opts.originalRepoDir, ".mcp.json");
    if (existsSync(origMcpPath)) {
      try {
        const origConfig = JSON.parse(readFileSync(origMcpPath, "utf-8"));
        if (origConfig.mcpServers && typeof origConfig.mcpServers === "object") {
          if (!existing.mcpServers) existing.mcpServers = {};
          for (const [name, serverConfig] of Object.entries(origConfig.mcpServers)) {
            // Skip ark-channel (we write our own) and don't override existing entries
            if (name !== "ark-channel" && !existing.mcpServers[name]) {
              existing.mcpServers[name] = serverConfig;
            }
          }
        }
      } catch (e: any) {
        console.error(
          `writeChannelConfig: failed to merge original repo MCP config from ${origMcpPath}:`,
          e?.message ?? e,
        );
      }
    }
  }

  // Merge runtime-declared MCP servers (e.g. from runtimes/claude.yaml). Same
  // precedence as the original-repo merge: do not override entries already
  // present in the worktree's .mcp.json or in the source repo's .mcp.json.
  if (opts?.runtimeMcpServers?.length) {
    if (!existing.mcpServers) existing.mcpServers = {};
    for (const entry of opts.runtimeMcpServers) {
      const resolved = resolveMcpServerEntry(entry, { mcpConfigsDir: opts.mcpConfigsDir });
      if (!resolved) continue;
      if (resolved.name === "ark-channel") continue;
      if (existing.mcpServers[resolved.name]) continue;
      existing.mcpServers[resolved.name] = resolved.config;
    }
  }

  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers["ark-channel"] = config;

  // Inject codebase-memory-mcp if the vendored binary is available.
  // It speaks MCP over stdio with no args -- invoking the binary directly
  // gives the agent its 14 code-intelligence tools (search_graph, trace_path,
  // get_architecture, search_code, manage_adr, etc.).
  // See docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md.
  const cbmBin = findCodebaseMemoryBinary();
  const cbmAvailable = cbmBin !== "codebase-memory-mcp" && existsSync(cbmBin);
  if (cbmAvailable && !existing.mcpServers["codebase-memory"]) {
    existing.mcpServers["codebase-memory"] = {
      command: cbmBin,
      args: [],
      env: {
        // Keep the HTTP graph UI disabled by default; arkd pool may override.
        CBM_UI_ENABLED: "false",
      },
    };
  }

  // Wave 1: gate the unified code-intel MCP behind the codeIntelV2 flag.
  // The MCP server itself ships in Wave 2; for now we leave the entry name
  // as the stable contract and skip injection until both the flag and the
  // server binary are present.
  if (opts?.enableCodeIntelV2 && !existing.mcpServers["ark-code-intel"]) {
    // The MCP server binary lands in Wave 2. Until then, the flag has no
    // observable effect at write-time -- intentional: we don't want to
    // inject a broken MCP entry, but we do want the gate to be wired so
    // downstream wiring lights up the moment the server ships.
    void existing;
  }

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

/**
 * PostCompact hook: re-inject the original task prompt after context compaction.
 * Reads the task from ~/.ark/tracks/<sessionId>/task.txt and echoes it as
 * a user-visible message so the agent retains its mission after compaction.
 */
function postCompactTaskHook(sessionId: string): Record<string, unknown> {
  const arkDir = process.env.ARK_TEST_DIR || `${process.env.HOME}/.ark`;
  const taskFile = `${arkDir}/tracks/${sessionId}/task.txt`;
  // Read task file and output a reminder. head -c to avoid ARG_MAX issues.
  const cmd = `if [ -f '${taskFile}' ]; then echo "TASK REMINDER (re-injected after context compaction):"; head -c 4000 '${taskFile}'; fi ${ARK_HOOK_MARKER}`;
  return { type: "command", command: cmd, async: true };
}

function buildHooksConfig(sessionId: string, conductorUrl: string, tenantId?: string): Record<string, unknown[]> {
  const cmd = hookCommand(sessionId, conductorUrl, tenantId);
  const asyncHook = { type: "command" as const, command: cmd, async: true };
  const syncHook = { type: "command" as const, command: cmd, async: false };

  // Each matcher group is tagged with _ark: true for reliable identification.
  // filterOutArkHooks uses this tag (with command-string fallback for old data).
  return {
    PreToolUse: [{ _ark: true, hooks: [syncHook] }],
    SessionStart: [{ _ark: true, matcher: "startup|resume", hooks: [asyncHook] }],
    UserPromptSubmit: [{ _ark: true, hooks: [asyncHook] }],
    Stop: [{ _ark: true, hooks: [asyncHook] }],
    StopFailure: [{ _ark: true, hooks: [asyncHook] }],
    SessionEnd: [{ _ark: true, hooks: [asyncHook] }],
    Notification: [{ _ark: true, matcher: "permission_prompt|idle_prompt", hooks: [asyncHook] }],
    PreCompact: [{ _ark: true, hooks: [asyncHook] }],
    PostCompact: [{ _ark: true, hooks: [asyncHook, postCompactTaskHook(sessionId)] }],
  };
}

/**
 * Remove all ark-managed hook entries from a hooks object, mutating it in place.
 * Uses the `_ark: true` tag as primary identification, falls back to command
 * string matching for backward compatibility with pre-tag settings files.
 */
function filterOutArkHooks(hooks: Record<string, unknown[]>): void {
  for (const [event, matchers] of Object.entries(hooks)) {
    hooks[event] = matchers.filter((m) => {
      const entry = m as { _ark?: boolean; hooks?: Array<{ command?: string }> };
      // Primary: tagged entries
      if (entry._ark === true) return false;
      // Fallback: command string matching (backward compat with untagged entries)
      if (entry.hooks?.some((h) => h.command?.includes(ARK_HOOK_MARKER))) return false;
      return true;
    });
    if (hooks[event].length === 0) delete hooks[event];
  }
}

/** Options for writing the unified Claude settings bundle (.claude/settings.local.json). */
export interface ClaudeSettingsOpts {
  autonomy?: string;
  agent?: AgentToolSpec;
  tenantId?: string;
}

/** Result of writeSettings -- includes path and verification status. */
export interface WriteSettingsResult {
  path: string;
  verified: boolean;
  hookCount: number;
  errors: string[];
}

/**
 * Ensure .claude/settings.local.json and .mcp.json are listed in the workdir's
 * .gitignore. Idempotent -- skips if already present. Only appends to an
 * existing .gitignore; does not create one (worktrees inherit from root).
 */
function ensureGitignore(workdir: string): void {
  const gitignorePath = join(workdir, ".gitignore");
  const entries = [".claude/settings.local.json", ".mcp.json"];

  if (!existsSync(gitignorePath)) return;

  let content = "";
  try {
    content = readFileSync(gitignorePath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split("\n");
  const missing = entries.filter((e) => !lines.some((l) => l.trim() === e));
  if (missing.length === 0) return;

  const suffix = content.endsWith("\n") ? "" : "\n";
  const block = `${suffix}# Ark-managed (written at dispatch, cleaned on stop)\n${missing.join("\n")}\n`;
  try {
    writeFileSync(gitignorePath, content + block);
  } catch (e: any) {
    console.error(`ensureGitignore: failed to update ${gitignorePath}:`, e?.message ?? e);
  }
}

/**
 * Verify that a settings file contains the expected ark hooks.
 * Returns a list of problems (empty = all good).
 */
export function verifySettings(settingsPath: string): string[] {
  const errors: string[] = [];
  if (!existsSync(settingsPath)) {
    errors.push(`Settings file does not exist: ${settingsPath}`);
    return errors;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch (e: any) {
    errors.push(`Settings file is not valid JSON: ${e?.message ?? e}`);
    return errors;
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    errors.push("Settings file has no hooks object");
    return errors;
  }

  const hooks = settings.hooks as Record<string, unknown[]>;
  const required = ["PreToolUse", "Stop", "SessionStart", "SessionEnd"];
  for (const event of required) {
    if (!hooks[event] || !Array.isArray(hooks[event]) || hooks[event].length === 0) {
      errors.push(`Missing required hook event: ${event}`);
    }
  }

  // Verify ark-tagged entries exist
  const arkEntries = Object.values(hooks)
    .flat()
    .filter((m) => (m as { _ark?: boolean })._ark === true);
  if (arkEntries.length === 0) {
    errors.push("No ark-tagged hook entries found");
  }

  return errors;
}

/**
 * Write the unified Claude settings bundle to .claude/settings.local.json.
 *
 * Manages three concerns in a single atomic write:
 *   1. Status hooks -- curl-based event reporting to the conductor
 *   2. Permissions -- allow list (from agent tools) and deny list (from autonomy level)
 *   3. _ark metadata -- tracks which settings are ark-managed for clean teardown
 *
 * Tagged entries: every ark-managed matcher group carries `_ark: true` so
 * filterOutArkHooks can identify them without fragile string matching.
 *
 * Idempotent: calling twice with the same args produces identical output.
 * User hooks are never clobbered -- ark entries are removed first, then re-added.
 */
export function writeSettings(
  sessionId: string,
  conductorUrl: string,
  workdir: string,
  opts?: ClaudeSettingsOpts,
): string {
  const claudeDir = join(workdir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.local.json");

  // Ensure the settings file won't be tracked by git
  ensureGitignore(workdir);

  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (e: any) {
      console.error(`writeSettings: failed to parse ${settingsPath}, starting fresh:`, e?.message ?? e);
      existing = {};
    }
  }

  // Remove previous ark hooks (idempotent)
  if (existing.hooks && typeof existing.hooks === "object") {
    filterOutArkHooks(existing.hooks as Record<string, unknown[]>);
    if (Object.keys(existing.hooks as object).length === 0) delete existing.hooks;
  }

  // Merge new hooks -- ark entries go first so they fire before user hooks
  const newHooks = buildHooksConfig(sessionId, conductorUrl, opts?.tenantId);
  const existingHooks = (existing.hooks ?? {}) as Record<string, unknown[]>;
  for (const [event, matchers] of Object.entries(newHooks)) {
    existingHooks[event] = [...matchers, ...(existingHooks[event] ?? [])];
  }
  existing.hooks = existingHooks;

  // Ark-managed state tracker
  const arkMeta = (existing._ark ?? {}) as Record<string, unknown>;
  arkMeta.sessionId = sessionId;
  arkMeta.conductorUrl = conductorUrl;
  arkMeta.updatedAt = new Date().toISOString();

  // Build permissions.allow from agent.tools + declared mcp_servers (if agent provided).
  // autonomy=full / --dangerously-skip-permissions is the explicit override: when set,
  // Claude Code bypasses this list. The allow list is authoritative when bypass is off.
  //
  // ark-channel is ALWAYS included -- it's system infrastructure injected by dispatch,
  // not declared in agent YAML. Without it, report/send_to_agent tools are blocked.
  if (opts?.agent) {
    const allow = buildPermissionsAllow(opts.agent);
    if (!allow.includes("mcp__ark-channel__*")) {
      allow.push("mcp__ark-channel__*");
    }
    // codebase-memory-mcp is system infrastructure injected by dispatch
    // (see writeChannelConfig). Agents get its 14 code-intelligence tools
    // for free without declaring it in mcp_servers.
    if (!allow.includes("mcp__codebase-memory__*")) {
      allow.push("mcp__codebase-memory__*");
    }
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

  existing._ark = arkMeta;

  // Atomic write via tmp + rename
  const tmpPath = settingsPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(existing, null, 2));
  renameSync(tmpPath, settingsPath);

  return settingsPath;
}

/**
 * Write settings with verification. Returns detailed result including
 * verification status. Use this from executors that need fail-fast behavior.
 */
export function writeSettingsVerified(
  sessionId: string,
  conductorUrl: string,
  workdir: string,
  opts?: ClaudeSettingsOpts,
): WriteSettingsResult {
  const path = writeSettings(sessionId, conductorUrl, workdir, opts);
  const errors = verifySettings(path);
  const hookCount = (() => {
    try {
      const s = JSON.parse(readFileSync(path, "utf-8"));
      return Object.keys(s.hooks ?? {}).length;
    } catch {
      return 0;
    }
  })();
  return { path, verified: errors.length === 0, hookCount, errors };
}

/**
 * Remove the ark-channel entry from the worktree's .mcp.json.
 * Mirrors removeSettings -- called on session stop/delete to avoid
 * stale MCP config pointing at a dead channel port.
 */
export function removeChannelConfig(workdir: string): void {
  const mcpConfigPath = join(workdir, ".mcp.json");
  if (!existsSync(mcpConfigPath)) return;

  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
  } catch (e: any) {
    console.error(`removeChannelConfig: failed to parse ${mcpConfigPath}:`, e?.message ?? e);
    return;
  }

  if (config.mcpServers && typeof config.mcpServers === "object") {
    delete config.mcpServers["ark-channel"];
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  }

  // If only empty object remains, remove the file entirely
  if (Object.keys(config).length === 0) {
    try {
      unlinkSync(mcpConfigPath);
    } catch {
      logDebug("session", "already gone");
    }
  } else {
    writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
  }
}

/**
 * Remove ark-managed settings from .claude/settings.local.json.
 * Only removes entries tagged by ark -- user hooks and other settings are preserved.
 * If nothing remains after cleanup, the file is deleted entirely.
 */
export function removeSettings(workdir: string): void {
  const settingsPath = join(workdir, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) return;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch (e: any) {
    console.error(`removeSettings: failed to parse ${settingsPath}:`, e?.message ?? e);
    return;
  }

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

  // If nothing meaningful remains, remove the file entirely
  const remainingKeys = Object.keys(settings);
  if (remainingKeys.length === 0) {
    try {
      unlinkSync(settingsPath);
    } catch {
      logDebug("session", "already gone");
    }
  } else {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }
}

/** @deprecated Use writeSettings instead */
export const writeHooksConfig = writeSettings;
/** @deprecated Use removeSettings instead */
export const removeHooksConfig = removeSettings;

// ── Launcher script ─────────────────────────────────────────────────────────

export interface LauncherOpts {
  workdir: string;
  claudeArgs: string[];
  mcpConfigPath: string;
  claudeSessionId?: string;
  prevClaudeSessionId?: string | null;
  /** @deprecated The `--remote-control` flag was removed (it spammed the host workspace
   *  with session breadcrumbs without producing anything the dashboard uses). Kept on
   *  the opts type only so existing callers compile; the value is now ignored. */
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
  // Channel config is in .mcp.json (project level), Claude reads it automatically.
  // --remote-control was dropped: it wrote session metadata into the host
  // workspace and nothing on the Ark side consumed it.
  const extraFlags = `--dangerously-load-development-channels server:ark-channel`;

  const envExports = Object.entries(opts.env ?? {})
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("\n");
  const envBlock = envExports ? envExports + "\n" : "";

  // Ensure tools are in PATH (claude, bun, nvm live in ~/.local/bin etc)
  // Can't source .bashrc -- it exits early for non-interactive shells
  const pathSetup = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.nvm/versions/node/*/bin:$PATH"\n`;

  // When initialPrompt is provided, append it as the last positional arg
  // to trigger immediate processing. Separate it from option values with
  // `--`: `--dangerously-load-development-channels` is greedy and would
  // otherwise consume the prompt as another channel entry. The `--` tells
  // Claude's arg parser "everything after this is a positional".
  const promptArg = opts.initialPrompt ? ` \\\n  -- ${shellQuote(opts.initialPrompt)}` : "";

  // Wrap the claude invocation so a non-zero exit is surfaced back to Ark.
  // `exec bash` below keeps the tmux pane alive (so the user can read the
  // error + debug), but without this sentinel, Ark's status poller sees the
  // tmux session as still "alive" and never flips the Ark session to
  // `failed`. The poller watches $ARK_SESSION_DIR/exit-code to detect this
  // case. See session-orchestration docs + status-poller.ts.
  //
  // `ARK_SESSION_DIR` is exported into the launch env by the executor
  // (see executors/claude-code.ts). If it is not set (defensive default),
  // we fall back to writing under /tmp so the file write never breaks the
  // launcher -- the poller just won't find the sentinel and the session
  // stays "running", which matches the pre-bug-3 behaviour.
  const sentinelDir = `"\${ARK_SESSION_DIR:-/tmp/ark-session-unknown}"`;
  const primary = opts.prevClaudeSessionId
    ? `${claudeCmd} --resume ${shellQuote(opts.prevClaudeSessionId)} \\
  ${extraFlags}${promptArg}`
    : `${claudeCmd} --session-id ${shellQuote(claudeSessionId)} \\
  ${extraFlags}${promptArg}`;
  const fallback = opts.prevClaudeSessionId
    ? `${claudeCmd} --session-id ${shellQuote(claudeSessionId)} \\
  ${extraFlags}${promptArg}`
    : null;

  const body = fallback
    ? `if ${primary}; then
  :
elif ${fallback}; then
  :
else
  code=$?
  mkdir -p ${sentinelDir} 2>/dev/null || true
  echo "$code" > ${sentinelDir}/exit-code
  echo "Claude exited with code $code. Session marked failed." >&2
fi`
    : `if ${primary}; then
  :
else
  code=$?
  mkdir -p ${sentinelDir} 2>/dev/null || true
  echo "$code" > ${sentinelDir}/exit-code
  echo "Claude exited with code $code. Session marked failed." >&2
fi`;

  const content = `#!/bin/bash
${pathSetup}cd ${shellQuote(opts.workdir)}
${envBlock}${body}
exec bash
`;

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
    try {
      symlinkSync(origProject, wtProject);
    } catch (e: any) {
      console.error(`trustWorktree: failed to symlink ${origProject} -> ${wtProject}:`, e?.message ?? e);
    }
  }

  trustDirectory(worktreeDir);
}

/** Pre-accept trust dialog for a local directory. */
export function trustDirectory(dir: string): void {
  const claudeJsonPath = join(homedir(), ".claude.json");
  try {
    const claudeJson = existsSync(claudeJsonPath) ? JSON.parse(readFileSync(claudeJsonPath, "utf-8")) : {};
    if (!claudeJson.projects) claudeJson.projects = {};
    const resolvedPath = resolve(dir);
    if (!claudeJson.projects[resolvedPath]?.hasTrustDialogAccepted) {
      claudeJson.projects[resolvedPath] = {
        ...(claudeJson.projects[resolvedPath] ?? {}),
        hasTrustDialogAccepted: true,
      };
      writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
    }
  } catch (e: any) {
    console.error(`trustDirectory: failed to update ${claudeJsonPath}:`, e?.message ?? e);
  }
}

// ── Channel prompt auto-accept ───────────────────────────────────────────────

const CHANNEL_PROMPT_MARKERS = ["I am using this for local", "local channel development"];
/** Indicators that Claude is past all prompts and actively working. */
const CLAUDE_WORKING_MARKERS = ["ctrl+o to expand", "esc to interrupt"];

/**
 * Poll tmux pane for the channel development prompt and auto-accept it.
 *
 * The launcher may use `--resume <id> || --session-id <id>`, which causes
 * TWO Claude startups (and two channel prompts) when resume fails.
 * To handle this, we keep polling after acceptance until Claude is actually
 * working -- we don't return after the first accept.
 *
 * Four outcomes per poll:
 * 1. Prompt found -> send "1" + Enter, keep polling for a second prompt
 * 2. No prompt and Claude is working (tool use visible) -> done
 * 3. No prompt but previously accepted one -> keep polling briefly
 * 4. Neither -> keep polling (Claude still starting up)
 */
export async function autoAcceptChannelPrompt(
  tmuxName: string,
  opts?: { maxAttempts?: number; delayMs?: number },
): Promise<void> {
  const max = opts?.maxAttempts ?? 60;
  const delay = opts?.delayMs ?? 500;
  let accepted = 0;

  for (let i = 0; i < max; i++) {
    await Bun.sleep(delay);
    try {
      const output = await tmux.capturePaneAsync(tmuxName, { lines: 40 });

      // Found the channel development prompt -- accept it
      if (CHANNEL_PROMPT_MARKERS.some((m) => output.includes(m))) {
        // Option 1 is pre-selected (> prefix). Send "1" to select it,
        // brief pause, then Enter to confirm. Also try just Enter in case
        // the selection is already active.
        await tmux.sendKeysAsync(tmuxName, "1");
        await Bun.sleep(200);
        await tmux.sendKeysAsync(tmuxName, "Enter");
        await Bun.sleep(500);
        // Double-tap Enter in case the first one was swallowed
        await tmux.sendKeysAsync(tmuxName, "Enter");
        accepted++;
        continue;
      }

      // Claude is actively working -- safe to stop polling
      if (CLAUDE_WORKING_MARKERS.some((m) => output.includes(m))) {
        return;
      }

      // If we already accepted at least once and the prompt markers are gone,
      // Claude is past the prompt even if working markers haven't appeared yet
      if (accepted > 0 && !CHANNEL_PROMPT_MARKERS.some((m) => output.includes(m))) {
        return;
      }
    } catch {
      logDebug("session", "tmux pane may not exist yet during startup");
    }
  }
}

// ── Channel task delivery ────────────────────────────────────────────────────

const deliveryInFlight = new Map<string, boolean>();

/**
 * Deliver a task to a Claude session via channel.
 * Tries arkd delivery first, then falls back to direct HTTP with retry.
 */
export async function deliverTask(
  sessionId: string,
  channelPort: number,
  task: string,
  stage: string,
  opts?: { arkdUrl?: string },
): Promise<void> {
  if (deliveryInFlight.get(sessionId)) return;
  deliveryInFlight.set(sessionId, true);

  const payload = { type: "task", task, sessionId, stage };

  try {
    // Try arkd delivery first
    if (opts?.arkdUrl) {
      try {
        const { ArkdClient } = await import("../../arkd/client.js");
        const client = new ArkdClient(opts.arkdUrl);
        const result = await client.channelDeliver({ channelPort, payload });
        if (result.delivered) return;
      } catch (e: any) {
        console.error(
          `deliverTask: arkd delivery failed for session ${sessionId}, falling back to direct:`,
          e?.message ?? e,
        );
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
      } catch {
        logInfo("session", "channel port not ready yet -- retry");
      }
      await Bun.sleep(1000);
    }
  } finally {
    deliveryInFlight.delete(sessionId);
  }
}
