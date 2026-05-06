import type { MigrationApplyContext } from "./types.js";
import { applyPostgresPtyCols } from "./015_pty_cols_postgres.js";

export const VERSION = 15;
export const NAME = "pty_cols";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "postgres") {
    await applyPostgresPtyCols(ctx.db);
  }
  // SQLite: schema.ts already declares pty_cols / pty_rows -- no-op
}
