// ── Centralized Ink color types and helpers ──────────────────────────────────
// Solves the Ink <Text color={...}> type mismatch that forces `as any` casts.

import type { SessionStatus, ComputeStatus } from "../../types/index.js";
import { getTheme } from "../../core/theme.js";

/**
 * Matches Ink's accepted color values for <Text color={...}>.
 * Named colors, bright variants, and hex strings.
 */
export type InkColor =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "gray" | "grey" | "blackBright" | "redBright" | "greenBright" | "yellowBright"
  | "blueBright" | "magentaBright" | "cyanBright" | "whiteBright"
  | `#${string}`;

/** Map a session status to a theme-aware Ink color. */
export function getStatusColor(status: SessionStatus | string): InkColor {
  const theme = getTheme();
  const map: Record<string, string> = {
    running: theme.running,
    ready: theme.accent,
    pending: theme.dimText,
    stopped: theme.dimText,
    waiting: theme.waiting,
    blocked: theme.waiting,
    completed: theme.running,
    failed: theme.error,
    archived: theme.dimText,
  };
  return (map[status] ?? theme.dimText) as InkColor;
}

/** Map a compute status to an Ink color. */
export function getComputeStatusColor(status: ComputeStatus | string): InkColor {
  const theme = getTheme();
  if (status === "running") return theme.running as InkColor;
  if (status === "provisioning") return theme.waiting as InkColor;
  if (status === "destroyed") return theme.error as InkColor;
  return theme.dimText as InkColor;
}

/** Map an event type string to a theme-aware Ink color. */
export function eventTypeColor(type: string): InkColor {
  const theme = getTheme();
  if (type.includes("error") || type.includes("failed") || type.includes("crashed")) return theme.error as InkColor;
  if (type.includes("completed") || type.includes("done") || type.includes("joined")) return theme.running as InkColor;
  if (type.includes("started") || type.includes("resumed") || type.includes("dispatch")) return theme.accent as InkColor;
  if (type.includes("ready") || type.includes("waiting") || type.includes("paused")) return theme.waiting as InkColor;
  if (type.includes("progress")) return theme.accent as InkColor;
  if (type.includes("stopped")) return theme.dimText as InkColor;
  return theme.text as InkColor;
}

/** Map a role string to an Ink color for message display. */
export function roleColor(role: string): InkColor {
  const theme = getTheme();
  if (role === "user") return theme.accent as InkColor;
  if (role === "agent") return theme.running as InkColor;
  if (role === "system") return theme.dimText as InkColor;
  return theme.dimText as InkColor;
}

/** Map an event log type to an Ink color. */
export function eventLogColor(type: string): InkColor {
  const theme = getTheme();
  if (type.includes("error") || type.includes("exit") || type.includes("fail")) return theme.error as InkColor;
  if (type.includes("complete")) return theme.running as InkColor;
  if (type.includes("start")) return theme.accent as InkColor;
  return theme.dimText as InkColor;
}
