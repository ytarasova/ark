/**
 * Migration 003 -- platform-docs foundation (Wave 2c).
 *
 *   1. Create the `code_intel_platform_docs` table (current-version row per
 *      workspace/doc_type with soft-delete semantics).
 *   2. Create the `code_intel_platform_doc_versions` table (immutable
 *      per-regeneration snapshot history).
 *
 * Both DDLs are idempotent (`CREATE TABLE IF NOT EXISTS`) so re-running the
 * migration is a no-op. The migration doesn't seed any docs -- the
 * `generatePlatformDocs()` driver does that lazily on first reindex (or on
 * demand via `ark code-intel docs regenerate`).
 */

import type { IDatabase } from "../../database/index.js";
import * as platformDocsSchema from "../schema/platform-docs.js";
import * as platformDocVersionsSchema from "../schema/platform-doc-versions.js";

export const VERSION = 3;
export const NAME = "platform_docs";

export interface MigrationApplyContext {
  db: IDatabase;
  dialect: "sqlite" | "postgres";
}

export function up(ctx: MigrationApplyContext): void {
  const docsDDL = ctx.dialect === "sqlite" ? platformDocsSchema.sqliteDDL() : platformDocsSchema.postgresDDL();
  const versionsDDL =
    ctx.dialect === "sqlite" ? platformDocVersionsSchema.sqliteDDL() : platformDocVersionsSchema.postgresDDL();
  ctx.db.exec(docsDDL);
  ctx.db.exec(versionsDDL);
}
