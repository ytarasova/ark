import type { SessionStatus } from "../ui/StatusDot.js";

/** Window inside which a session is considered live regardless of DB status. */
const LIVE_ACTIVITY_WINDOW_MS = 60_000;

/**
 * Resolve the user-facing status pill for a session.
 *
 * The persisted `session.status` is the source of truth, but it can lag the
 * actual agent state in two important cases:
 *
 *   1. The conductor crashed / restarted while an agent kept working on a
 *      remote worker. The DB row is frozen at `running` from before the
 *      crash, but no new updates flow until the agent next emits a status
 *      transition. Conversely, after a soft handoff the DB row may be `ready`
 *      while the agent is still mid-task on the worker.
 *   2. A late-arriving terminal hook (e.g. SessionEnd at the end of a long
 *      task) hasn't yet been processed but the agent has clearly been active
 *      in the last few seconds.
 *
 * Heuristic: if the persisted status would render as a non-live pill
 * (`pending`, `waiting`, or `stopped`) BUT the session has events in the
 * last LIVE_ACTIVITY_WINDOW_MS, upgrade the displayed status to `running`.
 * Terminal states (`completed`, `failed`) are always honoured -- they're
 * write-once and not subject to live-activity overrides.
 */
export function resolveDisplayStatus(
  session: any,
  events: Array<{ created_at?: string }>,
  normalize: (s: string) => SessionStatus,
): SessionStatus {
  const persisted = normalize(String(session?.status ?? ""));
  // Terminal / authoritative states never upgrade:
  //   - completed/failed: write-once results, post-hoc events are normal
  //     cleanup traffic (markDispatchFailedShared logs, etc.) and must not
  //     flip the pill back to running.
  //   - stopped: manual user kill via the UI / `ark stop`. Late-arriving
  //     hooks from a still-draining agent must not undo the user's intent.
  //   - running: already live, nothing to upgrade.
  if (persisted === "completed" || persisted === "failed" || persisted === "stopped" || persisted === "running") {
    return persisted;
  }

  const last = latestEventTime(events);
  if (last == null) return persisted;
  const ageMs = Date.now() - last;
  if (ageMs >= 0 && ageMs < LIVE_ACTIVITY_WINDOW_MS) {
    return "running";
  }
  return persisted;
}

function latestEventTime(events: Array<{ created_at?: string }>): number | null {
  let best: number | null = null;
  for (const ev of events) {
    if (!ev?.created_at) continue;
    const t = Date.parse(ev.created_at);
    if (!Number.isFinite(t)) continue;
    if (best == null || t > best) best = t;
  }
  return best;
}
