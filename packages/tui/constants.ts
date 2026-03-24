// ── Icons & Colors ───────────────────────────────────────────────────────────

export const ICON: Record<string, string> = {
  running: "●",    // filled = active
  ready: "○",      // empty = ready to start
  pending: "○",    // empty = waiting
  stopped: "■",    // square = stopped by user
  waiting: "◐",    // half = paused/waiting
  blocked: "◐",    // half = needs attention
  completed: "✓",  // check = done
  failed: "✕",     // x = error
};

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
