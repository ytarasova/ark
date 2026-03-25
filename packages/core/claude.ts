/**
 * Claude CLI integration — model mapping, argument building, trust management,
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

import * as tmux from "./tmux.js";
import { TRACKS_DIR } from "./store.js";
// TRACKS_DIR is now a function — call it at usage sites, not module level

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
}

export function buildArgs(opts: ClaudeArgsOpts): string[] {
  const args = ["claude"];

  if (opts.headless && opts.task) {
    args.push("-p", opts.task, "--verbose", "--output-format", "stream-json",
      "--dangerously-skip-permissions");
  }

  if (opts.sessionId) {
    args.push("--session-id", opts.sessionId);
  }

  const model = opts.model ? resolveModel(opts.model) : null;
  if (model) args.push("--model", model);

  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);

  if (!opts.headless) {
    args.push("--dangerously-skip-permissions");
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
  opts?: { conductorUrl?: string },
): Record<string, unknown> {
  const bunPath = join(homedir(), ".bun", "bin", "bun");
  return {
    command: bunPath,
    args: [join(__dirname, "channel.ts")],
    env: {
      ARK_SESSION_ID: sessionId,
      ARK_STAGE: stage,
      ARK_CHANNEL_PORT: String(channelPort),
      ARK_CONDUCTOR_URL: opts?.conductorUrl ?? "http://localhost:19100",
    },
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
  opts?: { conductorUrl?: string },
): string {
  const channelOpts = opts?.conductorUrl ? { conductorUrl: opts.conductorUrl } : undefined;

  // Write to worktree .mcp.json so Claude finds it
  const mcpConfigPath = join(workdir, ".mcp.json");
  const existing = existsSync(mcpConfigPath)
    ? JSON.parse(readFileSync(mcpConfigPath, "utf-8"))
    : {};
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers["ark-channel"] = channelMcpConfig(sessionId, stage, channelPort, channelOpts);
  writeFileSync(mcpConfigPath, JSON.stringify(existing, null, 2));

  // Also write a copy to tracks dir for reference
  const sessionDir = join(TRACKS_DIR(), sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "mcp.json"), JSON.stringify({ mcpServers: { "ark-channel": channelMcpConfig(sessionId, stage, channelPort, channelOpts) } }, null, 2));

  return mcpConfigPath;
}

// ── Hook-based status config ────────────────────────────────────────────────

const ARK_HOOK_MARKER = "# ark-status";

function hookCommand(sessionId: string, conductorUrl: string): string {
  return `curl -sf -X POST -H 'Content-Type: application/json' -d @- '${conductorUrl}/hooks/status?session=${sessionId}' > /dev/null 2>&1 || true ${ARK_HOOK_MARKER}`;
}

function buildHooksConfig(sessionId: string, conductorUrl: string): Record<string, unknown[]> {
  const cmd = hookCommand(sessionId, conductorUrl);
  const hook = { type: "command" as const, command: cmd, async: true };

  return {
    SessionStart: [{ matcher: "startup|resume", hooks: [hook] }],
    UserPromptSubmit: [{ hooks: [hook] }],
    Stop: [{ hooks: [hook] }],
    StopFailure: [{ hooks: [hook] }],
    SessionEnd: [{ hooks: [hook] }],
    Notification: [{ matcher: "permission_prompt|idle_prompt", hooks: [hook] }],
    PreCompact: [{ hooks: [hook] }],
    PostCompact: [{ hooks: [hook] }],
  };
}

export function writeHooksConfig(
  sessionId: string, conductorUrl: string, workdir: string,
): string {
  const claudeDir = join(workdir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.local.json");

  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
  }

  // Remove previous ark hooks (idempotent)
  if (existing.hooks && typeof existing.hooks === "object") {
    const hooks = existing.hooks as Record<string, unknown[]>;
    for (const [event, matchers] of Object.entries(hooks)) {
      hooks[event] = (matchers as any[]).filter(
        (m: any) => !m.hooks?.some((h: any) => h.command?.includes(ARK_HOOK_MARKER))
      );
      if (hooks[event].length === 0) delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete existing.hooks;
  }

  // Merge new hooks
  const newHooks = buildHooksConfig(sessionId, conductorUrl);
  const existingHooks = (existing.hooks ?? {}) as Record<string, unknown[]>;
  for (const [event, matchers] of Object.entries(newHooks)) {
    existingHooks[event] = [...(existingHooks[event] ?? []), ...matchers];
  }
  existing.hooks = existingHooks;

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
  try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { return; }

  if (!settings.hooks || typeof settings.hooks !== "object") return;

  const hooks = settings.hooks as Record<string, unknown[]>;
  for (const [event, matchers] of Object.entries(hooks)) {
    hooks[event] = (matchers as any[]).filter(
      (m: any) => !m.hooks?.some((h: any) => h.command?.includes(ARK_HOOK_MARKER))
    );
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ── Transcript usage parsing ────────────────────────────────────────────────

export interface TranscriptUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
}

export function parseTranscriptUsage(transcriptPath: string): TranscriptUsage {
  const usage: TranscriptUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
  };

  if (!existsSync(transcriptPath)) return usage;

  let content: string;
  try { content = readFileSync(transcriptPath, "utf-8"); } catch { return usage; }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") continue;
      const u = entry.message?.usage;
      if (!u) continue;
      usage.input_tokens += u.input_tokens ?? 0;
      usage.output_tokens += u.output_tokens ?? 0;
      usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
      usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    } catch {}
  }

  usage.total_tokens = usage.input_tokens + usage.output_tokens
    + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;

  return usage;
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

  let content: string;
  if (opts.prevClaudeSessionId) {
    content = `#!/bin/bash
cd ${shellQuote(opts.workdir)}
${envBlock}${claudeCmd} --resume ${shellQuote(opts.prevClaudeSessionId)} \\
  ${extraFlags} || \\
${claudeCmd} --session-id ${shellQuote(claudeSessionId)} \\
  ${extraFlags}
exec bash
`;
  } else {
    content = `#!/bin/bash
cd ${shellQuote(opts.workdir)}
${envBlock}${claudeCmd} --session-id ${shellQuote(claudeSessionId)} \\
  ${extraFlags}
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
    try { symlinkSync(origProject, wtProject); } catch {}
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
  } catch {}
}

// ── Channel prompt auto-accept ───────────────────────────────────────────────

const CHANNEL_PROMPT_MARKERS = [
  "I am using this for local",
  "local channel development",
];
/**
 * Poll tmux pane for the channel development prompt and auto-accept it.
 *
 * Three outcomes per poll:
 * 1. Prompt found → send "1" + Enter, done
 * 2. No prompt but Claude is working (tool use visible) → stop, prompt was
 *    already accepted or skipped. Don't send rogue keystrokes.
 * 3. Neither → keep polling (Claude still starting up)
 */
export async function autoAcceptChannelPrompt(
  tmuxName: string,
  opts?: { maxAttempts?: number; delayMs?: number },
): Promise<void> {
  const max = opts?.maxAttempts ?? 45;
  const delay = opts?.delayMs ?? 1000;

  for (let i = 0; i < max; i++) {
    await Bun.sleep(delay);
    try {
      const output = tmux.capturePane(tmuxName, { lines: 30 });

      // Found the prompt — accept it
      if (CHANNEL_PROMPT_MARKERS.some(m => output.includes(m))) {
        await tmux.sendKeysAsync(tmuxName, "1");
        await Bun.sleep(300);
        await tmux.sendKeysAsync(tmuxName, "Enter");
        return;
      }

      // Claude is already working — safe to stop polling.
      // These only appear after Claude has fully started and is past any prompts.
      if (output.includes("ctrl+o to expand") || output.includes("esc to interrupt")) {
        return;
      }
    } catch {}
  }
}

// ── Channel task delivery ────────────────────────────────────────────────────

const deliveryInFlight = new Map<string, boolean>();

/**
 * Deliver a task to a Claude session via channel HTTP POST.
 * Waits for the channel server to become ready, then posts the task.
 */
export async function deliverTask(
  sessionId: string, channelPort: number,
  task: string, stage: string,
): Promise<void> {
  if (deliveryInFlight.get(sessionId)) return;
  deliveryInFlight.set(sessionId, true);

  const url = `http://localhost:${channelPort}`;
  const payload = { type: "task", task, sessionId, stage };

  try {
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
      } catch {}
      await Bun.sleep(1000);
    }
  } finally {
    deliveryInFlight.delete(sessionId);
  }
}
