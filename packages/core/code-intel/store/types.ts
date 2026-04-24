/**
 * Public row types and JSON/time helpers for the code-intel store.
 *
 * These used to live at the top of store.ts; they are re-exported from there
 * for back-compat so no external caller has to change import paths.
 */

import type { ChunkKind, EdgeRelation, EntityKind, SubjectKind, SymbolKind } from "../interfaces/types.js";
import type { PlatformDocFlavor } from "../interfaces/platform-doc-extractor.js";

// -- Public row types ---------------------------------------------------------

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface Workspace {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  created_at: string;
  deleted_at: string | null;
}

export interface Repo {
  id: string;
  tenant_id: string;
  repo_url: string;
  name: string;
  default_branch: string;
  primary_language: string | null;
  local_path: string | null;
  config: Record<string, unknown>;
  created_at: string;
  deleted_at: string | null;
}

export interface IndexingRun {
  id: string;
  tenant_id: string;
  repo_id: string;
  branch: string;
  commit_sha: string | null;
  status: "running" | "ok" | "error" | "cancelled";
  extractor_counts: Record<string, number>;
  error_msg: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface FileRow {
  id: string;
  tenant_id: string;
  repo_id: string;
  path: string;
  sha: string;
  mtime: string | null;
  language: string | null;
  size_bytes: number | null;
  indexing_run_id: string;
  created_at: string;
  deleted_at: string | null;
}

export interface SymbolRow {
  id: string;
  tenant_id: string;
  file_id: string;
  kind: SymbolKind;
  name: string;
  fqn: string | null;
  signature: string | null;
  line_start: number | null;
  line_end: number | null;
  parent_symbol_id: string | null;
  indexing_run_id: string;
  created_at: string;
  deleted_at: string | null;
}

export interface ChunkRow {
  id: string;
  tenant_id: string;
  file_id: string;
  symbol_id: string | null;
  parent_chunk_id: string | null;
  chunk_kind: ChunkKind;
  content: string;
  line_start: number | null;
  line_end: number | null;
  attrs: Record<string, unknown>;
  indexing_run_id: string;
  created_at: string;
  deleted_at: string | null;
}

export interface EdgeRow {
  id: string;
  tenant_id: string;
  source_kind: EntityKind;
  source_id: string;
  target_kind: EntityKind;
  target_id: string;
  relation: EdgeRelation;
  evidence_chunk_id: string | null;
  weight: number;
  attrs: Record<string, unknown>;
  indexing_run_id: string;
  created_at: string;
  deleted_at: string | null;
}

export interface ExternalRefRow {
  id: string;
  tenant_id: string;
  symbol_id: string;
  external_repo_hint: string | null;
  external_fqn: string;
  resolved_symbol_id: string | null;
  resolved_at: string | null;
  indexing_run_id: string;
  created_at: string;
}

export interface EmbeddingRow {
  id: string;
  tenant_id: string;
  subject_kind: SubjectKind;
  subject_id: string;
  model: string;
  model_version: string;
  dim: number;
  vector: Uint8Array;
  indexing_run_id: string;
  created_at: string;
}

export interface DependencyRow {
  id: string;
  tenant_id: string;
  repo_id: string;
  file_id: string | null;
  manifest_kind: string;
  name: string;
  version_constraint: string | null;
  resolved_version: string | null;
  dep_type: "prod" | "dev" | "peer" | "optional";
  indexing_run_id: string;
  created_at: string;
  deleted_at: string | null;
}

export interface PersonRow {
  id: string;
  tenant_id: string;
  primary_email: string;
  name: string | null;
  alt_emails: string[];
  alt_names: string[];
  created_at: string;
}

export interface ContributionRow {
  id: string;
  tenant_id: string;
  person_id: string;
  repo_id: string;
  file_id: string | null;
  commit_count: number;
  loc_added: number;
  loc_removed: number;
  first_commit: string | null;
  last_commit: string | null;
  indexing_run_id: string;
  created_at: string;
  deleted_at: string | null;
}

export interface HotspotRow {
  id: string;
  tenant_id: string;
  file_id: string;
  change_count_30d: number;
  change_count_90d: number;
  authors_count: number;
  lines_touched: number;
  risk_score: number;
  computed_at: string;
  indexing_run_id: string;
  deleted_at: string | null;
}

export interface PlatformDoc {
  id: string;
  tenant_id: string;
  workspace_id: string;
  doc_type: string;
  title: string;
  content_md: string;
  source: Record<string, unknown>;
  generated_by: PlatformDocFlavor;
  generated_from_run_id: string | null;
  model: string | null;
  generated_at: string;
  deleted_at: string | null;
}

export interface PlatformDocVersion {
  id: string;
  doc_id: string;
  version: number;
  content_md: string;
  generated_at: string;
}

// -- Helpers ------------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString();
}

export function jsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

/** Escape / quote the FTS query so user input can't break the MATCH grammar. */
export function sanitizeFtsQuery(q: string): string {
  const cleaned = q
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  if (cleaned.length === 0) return '""';
  return cleaned.join(" ");
}
