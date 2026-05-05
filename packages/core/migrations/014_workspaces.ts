/**
 * Migration 014 -- workspaces + workspace_repos tables.
 *
 * The workspace concept (multi-repo grouping for cross-repo session
 * dispatch) used to live in the code-intel store. After code-intel was
 * dropped, workspaces got their own minimal store backed by these two
 * tables. Schema is identical to the relevant subset of the old
 * code-intel migration so existing-row migration is straightforward
 * (the rows themselves were dropped along with code-intel; greenfield
 * for now).
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteWorkspaces } from "./014_workspaces_sqlite.js";
import { applyPostgresWorkspaces } from "./014_workspaces_postgres.js";

export const VERSION = 14;
export const NAME = "workspaces";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteWorkspaces(ctx.db);
  } else {
    await applyPostgresWorkspaces(ctx.db);
  }
}
