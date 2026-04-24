/**
 * Shared CLI formatters -- status icons, colors, and status line renderers.
 *
 * Consolidates the session-status icon + color tables that were duplicated
 * across `session/view.ts`, `misc/pr.ts`, and `conductor.ts`. New callers
 * should import from here so the table has a single source of truth.
 */

import chalk from "chalk";

export type SessionStatus =
  | "running"
  | "waiting"
  | "pending"
  | "ready"
  | "completed"
  | "failed"
  | "blocked"
  | "archived";

const STATUS_ICONS: Record<string, string> = {
  running: "●",
  waiting: "⏸",
  pending: "○",
  ready: "◎",
  completed: "✓",
  failed: "✕",
  blocked: "■",
  archived: "▪",
};

const STATUS_COLORS: Record<string, (s: string) => string> = {
  running: chalk.blue,
  waiting: chalk.yellow,
  completed: chalk.green,
  failed: chalk.red,
  blocked: chalk.yellow,
  archived: chalk.dim,
};

export function statusIcon(status: string | undefined | null): string {
  if (!status) return "?";
  return STATUS_ICONS[status] ?? "?";
}

export function statusColor(status: string | undefined | null): (s: string) => string {
  if (!status) return chalk.dim;
  return STATUS_COLORS[status] ?? chalk.dim;
}

/**
 * Convenience: render a colored status icon. Equivalent to
 * `statusColor(status)(statusIcon(status))`.
 */
export function coloredStatusIcon(status: string | undefined | null): string {
  return statusColor(status)(statusIcon(status));
}
