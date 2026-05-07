/**
 * Ordered registry of every Ark migration.
 *
 * Add new migrations here in monotonic order. The runner refuses to apply
 * out-of-order versions and refuses to skip numbers.
 */

import type { Migration } from "./types.js";
import * as m001 from "./001_initial.js";
import * as m002 from "./002_compute_unify.js";
import * as m003 from "./003_tenants_teams.js";
import * as m004 from "./004_soft_delete.js";
import * as m005 from "./005_deleted_by.js";
import * as m006 from "./006_apikeys_soft_delete.js";
// --- BEGIN agent-F: migration 007 ---
import * as m007 from "./007_tenant_claude_auth.js";
// --- END agent-F ---
// --- BEGIN agent-G: migration 008 ---
import * as m008 from "./008_tenant_compute_config.js";
// --- END agent-G ---
// Migration 009: drizzle cutover marker (no DDL). See 009_drizzle_cutover.ts.
import * as m009 from "./009_drizzle_cutover.js";
// Migration 010: stage_operations table for RF-8 idempotency keys (#388).
import * as m010 from "./010_stage_operations.js";
// Migration 011: sessions.orchestrator column (future-proofing for temporal).
import * as m011 from "./011_session_orchestrator.js";
// Migration 012: rename compute.runtime_kind to compute.isolation_kind.
import * as m012 from "./012_isolation_kind_rename.js";
// Migration 013: retag eval knowledge nodes to type='eval_session' (#480).
import * as m013 from "./013_eval_session_type.js";
// Migration 014: standalone workspaces + workspace_repos tables (post code-intel).
import * as m014 from "./014_workspaces.js";
// Migration 015: drop legacy `provider` columns from compute + compute_templates;
// firecracker data fixup. See docs/superpowers/plans/2026-05-05-compute-cleanup.md.
import * as m015 from "./015_drop_legacy_provider_columns.js";
// Migration 016: add pty_cols / pty_rows to sessions (postgres schema parity).
import * as m016 from "./016_pty_cols.js";

export const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: m001.VERSION, name: m001.NAME, up: m001.up },
  { version: m002.VERSION, name: m002.NAME, up: m002.up },
  { version: m003.VERSION, name: m003.NAME, up: m003.up },
  { version: m004.VERSION, name: m004.NAME, up: m004.up },
  { version: m005.VERSION, name: m005.NAME, up: m005.up },
  { version: m006.VERSION, name: m006.NAME, up: m006.up },
  // --- BEGIN agent-F: migration 007 ---
  { version: m007.VERSION, name: m007.NAME, up: m007.up },
  // --- END agent-F ---
  // --- BEGIN agent-G: migration 008 ---
  { version: m008.VERSION, name: m008.NAME, up: m008.up },
  // --- END agent-G ---
  { version: m009.VERSION, name: m009.NAME, up: m009.up },
  { version: m010.VERSION, name: m010.NAME, up: m010.up },
  { version: m011.VERSION, name: m011.NAME, up: m011.up },
  { version: m012.VERSION, name: m012.NAME, up: m012.up },
  { version: m013.VERSION, name: m013.NAME, up: m013.up },
  { version: m014.VERSION, name: m014.NAME, up: m014.up },
  { version: m015.VERSION, name: m015.NAME, up: m015.up },
  { version: m016.VERSION, name: m016.NAME, up: m016.up },
];
