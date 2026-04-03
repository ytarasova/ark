// ── Icons & Colors ───────────────────────────────────────────────────────────

import { getTheme } from "../core/theme.js";

export const ICON: Record<string, string> = {
  running: "●",    // filled green = active
  ready: "◎",      // target = ready to dispatch
  pending: "○",    // empty = not started
  stopped: "■",    // square = stopped by user
  waiting: "◑",    // half = paused/waiting for input
  blocked: "◐",    // half = needs gate approval
  completed: "✔",  // heavy check = done successfully
  failed: "✖",     // heavy x = error
};

/** Session status to theme color mapping. Uses theme for dynamic dark/light support. */
export function getStatusColor(status: string): string {
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
  return map[status] ?? theme.dimText;
}

// Static fallback for compatibility — prefers getStatusColor() for theme support
export const COLOR: Record<string, string> = {
  running: "green",
  ready: "cyan",
  pending: "gray",
  stopped: "gray",
  waiting: "yellow",
  blocked: "yellow",
  completed: "green",
  failed: "red",
};
