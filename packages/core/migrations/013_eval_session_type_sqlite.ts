/**
 * SQLite half of migration 013 -- retag eval rows from type='session' to
 * type='eval_session'. metadata is stored as a TEXT blob of JSON, so the
 * filter uses json_extract to read `metadata.eval`. We accept truthy
 * forms (1, 'true') since different writers may have used different
 * boolean encodings.
 */

import type { DatabaseAdapter } from "../database/index.js";

const SQL =
  "UPDATE knowledge SET type = 'eval_session', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
  "WHERE type = 'session' AND json_extract(metadata, '$.eval') IN (1, 'true')";

export async function applySqliteEvalSessionType(db: DatabaseAdapter): Promise<void> {
  await db.exec(SQL);
}
