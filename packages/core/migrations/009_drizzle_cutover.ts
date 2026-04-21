/**
 * Migration 009 -- drizzle cutover marker.
 *
 * No DDL changes. This migration exists solely to record, in
 * `ark_schema_migrations`, the point at which new schema evolution
 * transitions from hand-coded `up()` bodies (001-008) to drizzle-kit
 * generated SQL (010 onwards).
 *
 * The hand-coded migrations 001-008 remain in the registry and still
 * execute on upgrades. The drizzle schema modules under
 * `packages/core/drizzle/schema/` are a type-level mirror of what those
 * migrations produced; drizzle-kit can now diff against them to detect
 * drift (via `make drift`) and generate future migration SQL.
 *
 * If a fresh install boots straight to 009, the legacy `initSchema` path
 * in `packages/core/repositories/schema.ts` has already materialized
 * every table this marker declares cutover for -- so there's nothing to
 * do here beyond writing the row to the apply log (which the runner
 * handles for us).
 */

import type { MigrationApplyContext } from "./types.js";

export const VERSION = 9;
export const NAME = "drizzle_cutover";

export async function up(_ctx: MigrationApplyContext): Promise<void> {
  // intentionally empty -- see module header
  return;
}
