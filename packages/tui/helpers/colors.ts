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
  };
  return (map[status] ?? theme.dimText) as InkColor;
}

/** Map a compute status to an Ink color. */
export function getComputeStatusColor(status: ComputeStatus | string): InkColor {
  if (status === "running") return "green";
  if (status === "provisioning") return "yellow";
  if (status === "destroyed") return "red";
  return "gray";
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
  if (role === "user") return getTheme().accent as InkColor;
  if (role === "agent") return "green";
  if (role === "system") return "gray";
  return "gray";
}

/** Map an event log type to an Ink color. */
export function eventLogColor(type: string): InkColor {
  if (type.includes("error") || type.includes("exit") || type.includes("fail")) return "red";
  if (type.includes("complete")) return "green";
  if (type.includes("start")) return getTheme().accent as InkColor;
  return "gray";
}
