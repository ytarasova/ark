/**
 * Migration 013 -- retag eval knowledge nodes to type "eval_session".
 *
 * Eval-harness sessions used to be stored as `type = 'session'` with
 * `metadata.eval = true` in the same bucket as production sessions. That
 * mixed the two namespaces in every store.search / listNodes call, and
 * eval rows leaked into the auto-injected agent-prompt context (#480).
 *
 * The proper fix moves eval nodes to a dedicated type. This migration
 * retags existing rows in place: any row with type='session' and a
 * metadata blob that has `"eval": true` becomes type='eval_session'.
 * The metadata.eval flag is left in place (a harmless leftover; readers
 * no longer rely on it because the type IS the source of truth now).
 *
 * Idempotent: re-running on already-migrated data is a no-op because
 * the WHERE clause requires type='session'.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteEvalSessionType } from "./013_eval_session_type_sqlite.js";
import { applyPostgresEvalSessionType } from "./013_eval_session_type_postgres.js";

export const VERSION = 13;
export const NAME = "eval_session_type";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteEvalSessionType(ctx.db);
  } else {
    await applyPostgresEvalSessionType(ctx.db);
  }
}
