import type { ProjectionInput } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("projectSessionActivity: deps not injected");
  return _deps;
}

/**
 * Idempotent session-level projection write.
 * Applies the given patch to the sessions row and records the projection sequence
 * number so that retries with the same or lower seq are no-ops.
 *
 * The unique index on session_projections is:
 *   idx_session_projections_pk ON session_projections(session_id, COALESCE(stage_idx, -1))
 * For session-level projections stage_idx is NULL, so the ON CONFLICT target
 * uses the functional expression via DO UPDATE.
 */
export async function projectSessionActivity(input: ProjectionInput): Promise<void> {
  const d = deps();
  const db = (d.sessions as any).db;

  // Idempotency guard: skip if we've already applied an equal or later seq.
  const existing = (await db
    .prepare("SELECT last_seq FROM session_projections WHERE session_id=? AND stage_idx IS NULL")
    .get(input.sessionId)) as { last_seq: number } | undefined;
  if (existing && existing.last_seq >= input.seq) return;

  // Apply patch to the live sessions row.
  if (Object.keys(input.patch).length > 0) {
    await (d.sessions as any).update(input.sessionId, input.patch);
  }

  // Upsert projection watermark. SQLite UNIQUE INDEX on (session_id, COALESCE(stage_idx,-1))
  // means we can use ON CONFLICT with a WHERE clause on stage_idx IS NULL.
  await db
    .prepare(
      `INSERT INTO session_projections(session_id, stage_idx, last_seq)
       VALUES(?, NULL, ?)
       ON CONFLICT(session_id, COALESCE(stage_idx, -1)) DO UPDATE SET last_seq = excluded.last_seq`,
    )
    .run(input.sessionId, input.seq);
}
