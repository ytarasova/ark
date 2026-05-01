/**
 * Unified Claude settings bundle writer / reader for `.claude/settings.local.json`.
 *
 * Manages status hooks, permissions (allow/deny), and `_ark` metadata for
 * clean teardown on session stop. Ark-tagged entries are identified via
 * `_ark: true`, with a command-string fallback for backward compatibility.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from "fs";
import { join } from "path";

import { logDebug } from "../observability/structured-log.js";

import { buildPermissionsAllow, type AgentToolSpec } from "./permissions.js";

// ── Hook-based status config ────────────────────────────────────────────────

const ARK_HOOK_MARKER = "# ark-status";

/**
 * Build the curl command Claude's hook system runs on every PreToolUse /
 * PostToolUse / AgentMessage / etc. event. The target is **local arkd**
 * (`http://localhost:<arkd-port>/hooks/forward`), not the conductor.
 * Arkd queues each event and the conductor pulls them via the existing
 * forward tunnel through `/events/stream`. This eliminates the brittle
 * SSH `-R` reverse tunnel that previously carried hook callbacks --
 * arkd is always reachable from the agent because both run on the same
 * host (laptop in local mode, EC2 in remote mode).
 *
 * `conductorUrl` is retained as a parameter only because callers persist
 * it in `_ark` metadata for human-debugging; it is NOT used for the
 * actual curl URL anymore.
 */
function hookCommand(sessionId: string, arkdUrl: string, tenantId?: string): string {
  const tenantHeader = tenantId ? ` -H 'X-Ark-Tenant-Id: ${tenantId}'` : "";
  return `curl -sf -X POST -H 'Content-Type: application/json'${tenantHeader} -d @- '${arkdUrl}/hooks/forward?session=${sessionId}' > /dev/null 2>&1 || true ${ARK_HOOK_MARKER}`;
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

function buildHooksConfig(sessionId: string, arkdUrl: string, tenantId?: string): Record<string, unknown[]> {
  const cmd = hookCommand(sessionId, arkdUrl, tenantId);
  const asyncHook = { type: "command" as const, command: cmd, async: true };
  const syncHook = { type: "command" as const, command: cmd, async: false };

  // Each matcher group is tagged with _ark: true for reliable identification.
  // filterOutArkHooks uses this tag (with command-string fallback for old data).
  return {
    PreToolUse: [{ _ark: true, hooks: [syncHook] }],
    // PostToolUse is required for the conversation timeline to flip a tool
    // call out of "INCOMPLETE" -- buildConversationTimeline merges
    // PostToolUse into the PreToolUse row to mark completion. Local
    // dispatch historically inferred this from the on-disk transcript file
    // (~/.claude/projects/.../*.jsonl), but for remote dispatch the
    // transcript lives on EC2 and the conductor can't read it. Subscribing
    // explicitly via the hook closes the loop for both cases.
    PostToolUse: [{ _ark: true, hooks: [asyncHook] }],
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
 * Pure builder: produces the JSON object Claude expects in
 * `.claude/settings.local.json` given the active session + conductor + agent
 * inputs, without touching the filesystem. Used both by `writeSettings` (which
 * adds I/O + idempotent merge with an existing local file) and by the remote
 * launcher path (which embeds the JSON as a heredoc so the launcher writes
 * the file in the remote workdir on first launch).
 *
 * For the remote path there is no "existing settings.local.json" to merge with
 * -- the remote workdir is freshly cloned. Callers that DO need the merge
 * pass the existing object in via `existing` (writeSettings does this).
 */
export function buildSettings(
  sessionId: string,
  arkdUrl: string,
  opts?: ClaudeSettingsOpts & { existing?: Record<string, unknown> },
): { object: Record<string, unknown>; content: string; hookCount: number } {
  const out: Record<string, unknown> = opts?.existing ? { ...opts.existing } : {};

  // Strip prior ark hooks (idempotent).
  if (out.hooks && typeof out.hooks === "object") {
    filterOutArkHooks(out.hooks as Record<string, unknown[]>);
    if (Object.keys(out.hooks as object).length === 0) delete out.hooks;
  }

  // Merge fresh ark hooks first so they fire before any user hooks.
  const newHooks = buildHooksConfig(sessionId, arkdUrl, opts?.tenantId);
  const existingHooks = (out.hooks ?? {}) as Record<string, unknown[]>;
  for (const [event, matchers] of Object.entries(newHooks)) {
    existingHooks[event] = [...matchers, ...(existingHooks[event] ?? [])];
  }
  out.hooks = existingHooks;

  // Ark-managed state tracker for clean teardown.
  const arkMeta = (out._ark ?? {}) as Record<string, unknown>;
  arkMeta.sessionId = sessionId;
  arkMeta.arkdUrl = arkdUrl;
  arkMeta.updatedAt = new Date().toISOString();

  // permissions.allow built from agent.tools + system MCPs.
  if (opts?.agent) {
    const allow = buildPermissionsAllow(opts.agent);
    if (!allow.includes("mcp__ark-channel__*")) allow.push("mcp__ark-channel__*");
    if (!allow.includes("mcp__codebase-memory__*")) allow.push("mcp__codebase-memory__*");
    const perms = (out.permissions ?? {}) as Record<string, unknown>;
    perms.allow = allow;
    out.permissions = perms;
    arkMeta.managedAllow = true;
  }

  // Pre-approve every MCP server we ship in .mcp.json so the agent doesn't
  // sit on Claude Code's first-run "trust this server?" prompt forever on
  // remote dispatch (where there's no human at the keyboard to press 1).
  // `enabledMcpjsonServers` is Claude Code's project-level pre-approval
  // list; entries match the keys of `.mcp.json:mcpServers`.
  const existingEnabled = Array.isArray(out.enabledMcpjsonServers) ? (out.enabledMcpjsonServers as string[]) : [];
  const enabledServers = new Set<string>(existingEnabled);
  enabledServers.add("ark-channel");
  enabledServers.add("codebase-memory");
  out.enabledMcpjsonServers = Array.from(enabledServers);

  if (opts?.autonomy === "edit") {
    const perms = (out.permissions ?? {}) as Record<string, unknown>;
    perms.deny = ["Bash"];
    out.permissions = perms;
    arkMeta.managedDeny = true;
  } else if (opts?.autonomy === "read-only") {
    const perms = (out.permissions ?? {}) as Record<string, unknown>;
    perms.deny = ["Bash", "Write", "Edit"];
    out.permissions = perms;
    arkMeta.managedDeny = true;
  }

  out._ark = arkMeta;

  return {
    object: out,
    content: JSON.stringify(out, null, 2),
    hookCount: Object.keys(out.hooks ?? {}).length,
  };
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
  arkdUrl: string,
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

  const { content } = buildSettings(sessionId, arkdUrl, { ...opts, existing });

  // Atomic write via tmp + rename
  const tmpPath = settingsPath + ".tmp";
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, settingsPath);

  return settingsPath;
}

/**
 * Write settings with verification. Returns detailed result including
 * verification status. Use this from executors that need fail-fast behavior.
 */
export function writeSettingsVerified(
  sessionId: string,
  arkdUrl: string,
  workdir: string,
  opts?: ClaudeSettingsOpts,
): WriteSettingsResult {
  const path = writeSettings(sessionId, arkdUrl, workdir, opts);
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
