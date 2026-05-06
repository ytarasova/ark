/**
 * Postgres half of migration 015 -- drop the legacy `provider` columns from
 * `compute` + `compute_templates` and drop the matching index. Mirrors the
 * SQLite half. Same firecracker data fixup + same column drops; Postgres
 * supports `IF EXISTS` natively so the body is shorter.
 */

import type { DatabaseAdapter } from "../database/index.js";

async function ddl(db: DatabaseAdapter, sql: string): Promise<void> {
  await db.exec(sql);
}

export async function applyPostgresDropLegacyProviderColumns(db: DatabaseAdapter): Promise<void> {
  // 1. Firecracker data fixup. Idempotent.
  await db
    .prepare(
      `UPDATE compute
        SET compute_kind = 'firecracker',
            isolation_kind = 'direct'
        WHERE compute_kind = 'local' AND isolation_kind = 'firecracker-in-container'`,
    )
    .run();
  await db
    .prepare(
      `UPDATE compute_templates
        SET compute_kind = 'firecracker',
            isolation_kind = 'direct'
        WHERE compute_kind = 'local' AND isolation_kind = 'firecracker-in-container'`,
    )
    .run();

  // 2. Drop the index that fed `findByProvider`.
  await ddl(db, "DROP INDEX IF EXISTS idx_compute_provider");

  // 3 + 4. Drop the legacy `provider` columns.
  await ddl(db, "ALTER TABLE compute DROP COLUMN IF EXISTS provider");
  await ddl(db, "ALTER TABLE compute_templates DROP COLUMN IF EXISTS provider");
}
