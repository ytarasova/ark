import type { DatabaseAdapter } from "../database/index.js";

export async function applyPostgresPtyCols(db: DatabaseAdapter): Promise<void> {
  await db.exec("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pty_cols INTEGER");
  await db.exec("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pty_rows INTEGER");
}
