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

// Sessions considered "finished" -- their worker process is gone, so they
// should never appear on a "running on this compute" table.
const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "stopped", "archived", "killed"]);

// Name of the seeded default compute row in local mode (see
// `seedLocalCompute` in packages/core/repositories/schema.ts, and
// `defaultProvider: "local"` in local-app-mode.ts). Sessions that run
// against the implicit local host resolve to this row but the dispatcher
// leaves their `compute_name` as NULL -- so we re-attribute them here.
const LOCAL_DEFAULT_COMPUTE_NAME = "local";

/**
 * Answer: "which live workers belong to the compute row on screen?"
 *
 * Three independent rules, applied together:
 *
 *   1. `compute_name` must match the on-screen compute, OR be null only
 *      when the on-screen compute IS the seeded `local` row. Without the
 *      local-only fallback, every unattached session shows up on every
 *      compute panel (the "compute panel shows wrong sessions" bug).
 *      The dispatcher leaves `compute_name=null` for sessions that
 *      resolve against the implicit local host -- those sessions are
 *      running on `local`, not on the EC2 / k8s row the user is viewing.
 *
 *   2. Status must be non-terminal. A completed / failed / stopped /
 *      archived / killed row has no live worker; parking it under a
 *      compute panel implies otherwise.
 *
 *   3. `session_id` (the tmux/process handle) must be set. Rows without
 *      one are either dispatch-failed limbo or pre-launch-agent stubs --
 *      they render as empty first-column cells otherwise.
 */
export function filterSessionsForCompute<
  T extends { compute_name?: string | null; status?: string; session_id?: string | null },
>(sessions: T[], computeName: string): T[] {
  const isLocal = computeName === LOCAL_DEFAULT_COMPUTE_NAME;
  return sessions.filter((s) => {
    if (s.compute_name == null) {
      if (!isLocal) return false;
    } else if (s.compute_name !== computeName) {
      return false;
    }
    if (s.status && TERMINAL_SESSION_STATUSES.has(s.status)) return false;
    if (!s.session_id) return false;
    return true;
  });
}
