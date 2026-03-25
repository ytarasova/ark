// ── Icons & Colors ───────────────────────────────────────────────────────────

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
