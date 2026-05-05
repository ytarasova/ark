/**
 * Postgres half of migration 013 -- retag eval rows from type='session'
 * to type='eval_session'. The metadata column is stored as TEXT (a
 * JSON-serialised string), not JSONB, so we cast to jsonb for the
 * predicate.
 */

import type { DatabaseAdapter } from "../database/index.js";

const SQL =
  "UPDATE knowledge SET type = 'eval_session', updated_at = NOW()::text " +
  "WHERE type = 'session' AND (metadata::jsonb ->> 'eval') = 'true'";

export async function applyPostgresEvalSessionType(db: DatabaseAdapter): Promise<void> {
  await db.exec(SQL);
}
