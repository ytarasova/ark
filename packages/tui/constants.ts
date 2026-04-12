// ── Icons & Colors ───────────────────────────────────────────────────────────

// Re-export getStatusColor from centralized colors module
export { getStatusColor } from "./helpers/colors.js";
export type { InkColor } from "./helpers/colors.js";

export const ICON: Record<string, string> = {
  running: "●",    // filled green = active
  ready: "◎",      // target = ready to dispatch
  pending: "○",    // empty = not started
  stopped: "■",    // square = stopped by user
  waiting: "◑",    // half = paused/waiting for input
  blocked: "◐",    // half = needs gate approval
  completed: "✔",  // heavy check = done successfully
  failed: "✖",     // heavy x = error
  archived: "▫",   // small square = archived/stored
};

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
  archived: "gray",
};
