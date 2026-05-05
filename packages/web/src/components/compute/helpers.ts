// ── Helpers ─────────────────────────────────────────────────────────────────

export function statusDotColor(status: string): string {
  switch (status) {
    case "running":
      return "bg-[var(--running)] shadow-[0_0_6px_rgba(96,165,250,0.5)]";
    case "stopped":
      return "bg-[var(--failed)]";
    case "pending":
    case "provisioning":
      return "bg-[var(--waiting)]";
    default:
      return "bg-muted-foreground/30";
  }
}

export function pctColor(pct: number): string {
  if (pct >= 90) return "var(--failed, #f87171)";
  if (pct >= 70) return "var(--waiting, #fbbf24)";
  return "var(--completed, #34d399)";
}

export function pctBarClass(pct: number): string {
  if (pct >= 90) return "bg-[var(--failed)]";
  if (pct >= 70) return "bg-[var(--waiting)]";
  return "bg-[var(--completed)]";
}

export function isArkProcess(command: string): boolean {
  const patterns = ["claude", "codex", "gemini", "goose", "tmux", "ark", "bun", "conductor", "channel"];
  const lower = command.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}
