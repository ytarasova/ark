import type { DatabaseAdapter } from "../../database/index.js";

export interface ProjectionDiff {
  sessionId: string;
  field: string;
  realValue: unknown;
  shadowValue: unknown;
}

/**
 * Compare real projections (Temporal) against shadow projections (bespoke + stub activities).
 * Returns an array of diffs -- empty means parity.
 */
export async function diffProjections(db: DatabaseAdapter, sessionId: string): Promise<ProjectionDiff[]> {
  const real = (await db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId)) as
    | Record<string, unknown>
    | undefined;
  const shadow = (await db
    .prepare("SELECT * FROM session_projections_shadow WHERE session_id=? AND stage_idx IS NULL")
    .get(sessionId)) as Record<string, unknown> | undefined;

  if (!real || !shadow) return [];

  const COMPARE_FIELDS = ["status", "stage", "error", "pr_url"] as const;
  const diffs: ProjectionDiff[] = [];
  for (const field of COMPARE_FIELDS) {
    if (real[field] !== (shadow as any)[field]) {
      diffs.push({ sessionId, field, realValue: real[field], shadowValue: (shadow as any)[field] });
    }
  }
  return diffs;
}
