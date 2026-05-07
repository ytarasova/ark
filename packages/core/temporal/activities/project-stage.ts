import type { ProjectionInput } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("projectStageActivity: deps not injected");
  return _deps;
}

/**
 * Idempotent stage-level projection write.
 * Records the stage-scoped projection watermark so that retries with the same
 * or lower seq are no-ops.
 *
 * Unlike session-level projections, stage_idx is always an integer here,
 * so the ON CONFLICT can target the concrete (session_id, stage_idx) pair
 * directly (the index covers COALESCE(stage_idx, -1) which resolves to
 * stage_idx for non-NULL values).
 */
export async function projectStageActivity(input: ProjectionInput): Promise<void> {
  const d = deps();
  const stageIdx = input.stageIdx ?? 0;
  const db = (d.sessions as any).db;

  // Idempotency guard.
  const existing = (await db
    .prepare("SELECT last_seq FROM session_projections WHERE session_id=? AND stage_idx=?")
    .get(input.sessionId, stageIdx)) as { last_seq: number } | undefined;
  if (existing && existing.last_seq >= input.seq) return;

  await db
    .prepare(
      `INSERT INTO session_projections(session_id, stage_idx, last_seq)
       VALUES(?, ?, ?)
       ON CONFLICT(session_id, COALESCE(stage_idx, -1)) DO UPDATE SET last_seq = excluded.last_seq`,
    )
    .run(input.sessionId, stageIdx, input.seq);
}
