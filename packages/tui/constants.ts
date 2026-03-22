// ── Icons & Colors ───────────────────────────────────────────────────────────

export const ICON: Record<string, string> = {
  running: "●", waiting: "⏸", pending: "○", ready: "◎",
  completed: "✓", failed: "✕", blocked: "■",
};

export const COLOR: Record<string, string> = {
  running: "blue", waiting: "yellow", completed: "green",
  failed: "red", blocked: "yellow", ready: "cyan",
};
