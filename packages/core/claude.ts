/**
 * Claude CLI integration — model mapping, argument building, trust management,
 * channel config, launcher generation, and prompt auto-accept.
 *
 * All Claude-specific knowledge lives here so session.ts and agent.ts
 * stay domain-focused.
 */

import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

import * as tmux from "./tmux.js";
import { TRACKS_DIR } from "./store.js";

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
): Record<string, unknown> {
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

/** Write MCP config file for a session's channel server. */
export function writeChannelConfig(
  sessionId: string, stage: string, channelPort: number,
): string {
  const sessionDir = join(TRACKS_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const mcpConfigPath = join(sessionDir, "mcp.json");
  const config = {
    mcpServers: {
      "ark-channel": channelMcpConfig(sessionId, stage, channelPort),
    },
  };
  writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
  return mcpConfigPath;
}

// ── Launcher script ─────────────────────────────────────────────────────────

export interface LauncherOpts {
  workdir: string;
  claudeArgs: string[];
  mcpConfigPath: string;
  claudeSessionId?: string;
  prevClaudeSessionId?: string | null;
}

/** Generate launcher bash script content. */
export function buildLauncher(opts: LauncherOpts): { content: string; claudeSessionId: string } {
  const claudeSessionId = opts.claudeSessionId ?? randomUUID();
  const claudeCmd = shellQuoteArgs(opts.claudeArgs);
  const channelFlags = `--mcp-config ${shellQuote(opts.mcpConfigPath)} --dangerously-load-development-channels server:ark-channel`;

  let content: string;
  if (opts.prevClaudeSessionId) {
    content = `#!/bin/bash
cd ${shellQuote(opts.workdir)}
${claudeCmd} --resume ${shellQuote(opts.prevClaudeSessionId)} --dangerously-skip-permissions \\
  ${channelFlags} || \\
${claudeCmd} --session-id ${shellQuote(claudeSessionId)} --dangerously-skip-permissions \\
  ${channelFlags}
exec bash
`;
  } else {
    content = `#!/bin/bash
cd ${shellQuote(opts.workdir)}
${claudeCmd} --session-id ${shellQuote(claudeSessionId)} --dangerously-skip-permissions \\
  ${channelFlags}
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
const SUCCESS_MARKERS = ["Welcome", "Claude Code v", "$"];

/**
 * Poll tmux pane for the channel development prompt and auto-accept it.
 * Fire-and-forget — returns a promise but callers don't need to await it.
 */
export async function autoAcceptChannelPrompt(
  tmuxName: string,
  opts?: { maxAttempts?: number; delayMs?: number },
): Promise<void> {
  const max = opts?.maxAttempts ?? 30;
  const delay = opts?.delayMs ?? 1000;

  for (let i = 0; i < max; i++) {
    await Bun.sleep(delay);
    try {
      const output = tmux.capturePane(tmuxName, { lines: 30 });
      if (CHANNEL_PROMPT_MARKERS.some(m => output.includes(m))) {
        // Send "1" first (selects option 1), then Enter to confirm
        tmux.sendKeys(tmuxName, "1");
        await Bun.sleep(200);
        tmux.sendKeys(tmuxName, "Enter");
        return;
      }
      if (SUCCESS_MARKERS.some(m => output.includes(m))) return;
    } catch { return; }
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
