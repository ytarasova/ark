/**
 * Status detection from tmux pane content.
 * Analyzes terminal output to determine if an agent is running, waiting, or idle.
 * Fallback for when hook-based detection is unavailable.
 */

import { capturePaneAsync } from "./tmux.js";

export type DetectedStatus = "running" | "waiting" | "idle" | "unknown";

// Patterns indicating the agent is actively working
const BUSY_PATTERNS = [
  /ctrl\+c to interrupt/i,
  /esc to interrupt/i,
  /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,  // braille spinner chars
  /\*\s*.+\.\.\./,  // asterisk spinner + loading text
  /\(\d+s\s*[·•]\s*\d+\s*tokens?\)/i,  // Claude timing indicator
  /thinking\.\.\./i,
  /processing\.\.\./i,
  /working\.\.\./i,
];

// Patterns indicating the agent is waiting for user input
const PROMPT_PATTERNS = [
  /^>\s*$/m,           // bare prompt
  /^❯\s*$/m,          // arrow prompt
  /Yes,?\s*allow/i,    // permission prompt
  /Enter to confirm/i,
  /\[y\/n\]/i,
  /Press Enter/i,
];

// Patterns indicating the agent has completed/exited
const IDLE_PATTERNS = [
  /\$\s*$/m,           // shell prompt at end
  /session ended/i,
  /goodbye/i,
];

/** Strip ANSI escape codes from terminal content. */
export function stripAnsi(content: string): string {
  // eslint-disable-next-line no-control-regex
  return content.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** Detect agent status from terminal content. */
export function detectStatusFromContent(content: string): DetectedStatus {
  const clean = stripAnsi(content);
  const lastLines = clean.split("\n").slice(-15).join("\n");

  // Check busy patterns first (highest priority)
  for (const pattern of BUSY_PATTERNS) {
    if (pattern.test(lastLines)) return "running";
  }

  // Check prompt patterns (waiting for input)
  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(lastLines)) return "waiting";
  }

  // Check idle patterns
  for (const pattern of IDLE_PATTERNS) {
    if (pattern.test(lastLines)) return "idle";
  }

  return "unknown";
}

/** Detect status for a tmux session by capturing pane content. */
export async function detectSessionStatus(tmuxSessionName: string): Promise<DetectedStatus> {
  try {
    const content = await capturePaneAsync(tmuxSessionName, { lines: 30 });
    if (!content.trim()) return "unknown";
    return detectStatusFromContent(content);
  } catch {
    return "unknown";
  }
}
