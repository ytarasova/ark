/**
 * tmux session management - create, attach, capture, send, kill.
 *
 * Each agent session runs in a tmux session. This module provides
 * a clean API over tmux CLI commands.
 *
 * Most functions are async. A few fast sync versions are kept for
 * startup checks and test guards (hasTmux, sessionExists, killSession).
 */

import { execFile, execFileSync, spawn } from "child_process";
import { promisify } from "util";
import { writeFileSync, mkdirSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const execFileAsync = promisify(execFile);

/** Ark tmux config: Ctrl+Q to detach, mouse, big history */
const ARK_TMUX_CONF = `
set -g mouse on
set -g history-limit 50000
set -ga update-environment "TERM TERM_PROGRAM COLORTERM"
set -g status-left ""
set -g status-right " Ctrl+Q detach | #{session_name} "
set -g status-style "bg=colour235,fg=colour248"
set -g status-right-style "bg=colour235,fg=colour214"
# Ctrl+Q to detach (no prefix needed)
bind -n C-q detach-client
`.trim();

/** Ensure ~/.ark/tmux.conf exists, return its path */
function ensureTmuxConf(arkDir: string): string {
  mkdirSync(arkDir, { recursive: true });
  const confPath = join(arkDir, "tmux.conf");
  writeFileSync(confPath, ARK_TMUX_CONF + "\n");
  return confPath;
}

export interface TmuxSession {
  name: string;
  alive: boolean;
}

/** Check if tmux is available (sync — one-shot startup check) */
export function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Check if a tmux session exists (sync — fast guard) */
export function sessionExists(name: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Check if a tmux session exists (async) */
export async function sessionExistsAsync(name: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", name], { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

/** Kill a tmux session (sync — fast, used in cleanup) */
export function killSession(name: string): boolean {
  try {
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Kill a tmux session (async) */
export function killSessionAsync(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const cp = spawn("tmux", ["kill-session", "-t", name], { stdio: "pipe" });
    cp.on("close", (code) => resolve(code === 0));
    cp.on("error", () => resolve(false));
  });
}

/** Create a new tmux session running a command (async) */
export async function createSessionAsync(name: string, command: string, opts?: {
  width?: number;
  height?: number;
  arkDir?: string;
}): Promise<void> {
  await killSessionAsync(name);
  const conf = ensureTmuxConf(opts?.arkDir ?? join(tmpdir(), "ark"));
  await execFileAsync("tmux", [
    "-f", conf,
    "new-session", "-d", "-s", name,
    "-x", String(opts?.width ?? 220),
    "-y", String(opts?.height ?? 50),
    "bash", "-c", command,
  ]);
}

/** Create a tmux session with a shell, then send a command via send-keys (async) */
export async function createSessionWithSendKeysAsync(name: string, command: string, opts?: {
  width?: number;
  height?: number;
  arkDir?: string;
}): Promise<void> {
  await killSessionAsync(name);
  const conf = ensureTmuxConf(opts?.arkDir ?? join(tmpdir(), "ark"));
  await execFileAsync("tmux", [
    "-f", conf,
    "new-session", "-d", "-s", name,
    "-x", String(opts?.width ?? 220),
    "-y", String(opts?.height ?? 50),
  ]);
  await execFileAsync("tmux", ["send-keys", "-t", name, command, "Enter"]);
}

/** Capture pane output (async) */
export async function capturePaneAsync(name: string, opts?: {
  lines?: number;
  ansi?: boolean;
}): Promise<string> {
  try {
    const args = ["capture-pane", "-t", name, "-p", "-S", `-${opts?.lines ?? 50}`];
    if (opts?.ansi) args.splice(4, 0, "-e");
    const { stdout } = await execFileAsync("tmux", args, { encoding: "utf-8" });
    return stdout;
  } catch {
    return "";
  }
}

/** Send text to a tmux session via load-buffer (async) */
export async function sendTextAsync(name: string, text: string): Promise<void> {
  const tmpFile = join(tmpdir(), `.ark-msg-${Date.now()}.txt`);
  writeFileSync(tmpFile, text);
  try {
    await execFileAsync("tmux", ["load-buffer", "-b", "ark-msg", tmpFile]);
    await execFileAsync("tmux", ["paste-buffer", "-b", "ark-msg", "-t", name]);
    await execFileAsync("tmux", ["send-keys", "-t", name, "Enter"]);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/** Send keys to a tmux session (async) */
export async function sendKeysAsync(name: string, ...keys: string[]): Promise<void> {
  await execFileAsync("tmux", ["send-keys", "-t", name, ...keys]);
}

/** Get the attach command for a session */
export function attachCommand(name: string, opts?: {
  compute?: string;
  host?: string;
  user?: string;
  sshKey?: string;
}): string {
  if (opts?.host) {
    const keyFlag = opts.sshKey ? `-i ${opts.sshKey} ` : "";
    return `ssh ${keyFlag}-t ${opts.user ?? "ubuntu"}@${opts.host} tmux attach -t ${name}`;
  }
  return `tmux attach -t ${name}`;
}

/** List all ark tmux sessions (async) */
export async function listArkSessionsAsync(): Promise<TmuxSession[]> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8",
    });
    return stdout.split("\n")
      .filter((s) => s.startsWith("ark-") || s.startsWith("s-"))
      .map((name) => ({ name, alive: true }));
  } catch {
    return [];
  }
}

/** Write a launcher script and return the path */
export function writeLauncher(sessionId: string, content: string, tracksDir: string): string {
  const dir = join(tracksDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "launch.sh");
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}
