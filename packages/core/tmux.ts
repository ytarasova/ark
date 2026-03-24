/**
 * tmux session management - create, attach, capture, send, kill.
 *
 * Each agent session runs in a tmux session. This module provides
 * a clean API over tmux CLI commands. No sleeps - uses tmux primitives.
 */

import { execSync, execFile, execFileSync, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { TRACKS_DIR } from "./store.js";

const execFileAsync = promisify(execFile);

export interface TmuxSession {
  name: string;
  alive: boolean;
}

/** Check if tmux is available */
export function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Check if a tmux session exists */
export function sessionExists(name: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Check if a tmux session exists (async - non-blocking) */
export async function sessionExistsAsync(name: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", name], { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/** Kill a tmux session */
export function killSession(name: string): boolean {
  try {
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Kill a tmux session (async - non-blocking) */
export function killSessionAsync(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const cp = spawn("tmux", ["kill-session", "-t", name], { stdio: "pipe" });
    cp.on("close", (code) => resolve(code === 0));
    cp.on("error", () => resolve(false));
  });
}

/** Create a new tmux session running a command directly (no shell prompt) */
export function createSession(name: string, command: string, opts?: {
  width?: number;
  height?: number;
}): void {
  killSession(name); // clean up any existing
  execFileSync("tmux", [
    "new-session", "-d", "-s", name,
    "-x", String(opts?.width ?? 220),
    "-y", String(opts?.height ?? 50),
    "bash", "-c", command,
  ], { stdio: "pipe" });
}

/** Create a tmux session with a shell, then send a command via send-keys */
export function createSessionWithSendKeys(name: string, command: string, opts?: {
  width?: number;
  height?: number;
}): void {
  killSession(name);
  execFileSync("tmux", [
    "new-session", "-d", "-s", name,
    "-x", String(opts?.width ?? 220),
    "-y", String(opts?.height ?? 50),
  ], { stdio: "pipe" });
  execFileSync("tmux", ["send-keys", "-t", name, command, "Enter"], { stdio: "pipe" });
}

/** Capture pane output (plain text or with ANSI codes) */
export function capturePane(name: string, opts?: {
  lines?: number;
  ansi?: boolean;
}): string {
  try {
    const args = ["capture-pane", "-t", name, "-p", "-S", `-${opts?.lines ?? 50}`];
    if (opts?.ansi) args.splice(4, 0, "-e");
    return execFileSync("tmux", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

/** Capture pane output (async - non-blocking) */
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

/** Send text to a tmux session via load-buffer (handles long text without paste overflow) */
export function sendText(name: string, text: string): void {
  const tmpFile = join(TRACKS_DIR(), `.msg-${Date.now()}.txt`);
  writeFileSync(tmpFile, text);
  try {
    execFileSync("tmux", ["load-buffer", "-b", "ark-msg", tmpFile], { stdio: "pipe" });
    execFileSync("tmux", ["paste-buffer", "-b", "ark-msg", "-t", name], { stdio: "pipe" });
    execFileSync("tmux", ["send-keys", "-t", name, "Enter"], { stdio: "pipe" });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/** Send keys to a tmux session (for short text or special keys) */
export function sendKeys(name: string, ...keys: string[]): void {
  execFileSync("tmux", ["send-keys", "-t", name, ...keys], { stdio: "pipe" });
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

/** List all ark tmux sessions */
export function listArkSessions(): TmuxSession[] {
  try {
    const output = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    return output.split("\n")
      .filter((s) => s.startsWith("ark-") || s.startsWith("s-"))
      .map((name) => ({ name, alive: true }));
  } catch {
    return [];
  }
}

/** Write a launcher script and return the path */
export function writeLauncher(sessionId: string, content: string): string {
  const dir = join(TRACKS_DIR(), sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "launch.sh");
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

