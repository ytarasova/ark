/**
 * Shared domain types used by the code-intel interfaces.
 *
 * These are the TypeScript shapes of rows flowing in and out of the store.
 * They mirror the DDL emitted by the schema modules but are the lingua franca
 * between extractors, queries, rankers, and policies.
 */

/** Row kinds an extractor can emit. Extend conservatively; each kind lines up with a table. */
export type RowKind =
  | "files"
  | "symbols"
  | "chunks"
  | "edges"
  | "endpoints"
  | "configs"
  | "infra_resources"
  | "dependencies"
  | "test_mappings"
  | "people"
  | "contributions"
  | "file_hotspots"
  | "external_refs"
  | "embeddings"
  // Wave 2 row kinds -- listed so interface consumers type-check against them today.
  | "semantic_annotations"
  | "contracts"
  | "test_assertions";

/** Symbol kinds referenced by the symbols table + graph edges. */
export type SymbolKind = "class" | "function" | "method" | "struct" | "enum" | "var" | "interface" | "module" | "other";

/** Chunk kinds referenced by the chunks table. */
export type ChunkKind = "code" | "doc" | "comment" | "config" | "fixture" | "other";

/** Edge relation kinds referenced by the edges table. */
export type EdgeRelation =
  | "calls"
  | "imports"
  | "depends_on"
  | "defines"
  | "contains"
  | "references"
  | "tests"
  | "modified_by"
  | "deployed_via"
  | "interop";

/** Kinds that can appear as edge endpoints. */
export type EntityKind = "file" | "symbol" | "chunk" | "endpoint" | "config" | "dependency" | "session";

/** Subject kinds for embeddings / external_refs / annotations. */
export type SubjectKind = "chunk" | "symbol" | "endpoint" | "config" | "doc" | "file";

/** A minimal repo descriptor passed to extractors + queries. */
export interface Repo {
  id: string;
  tenant_id: string;
  repo_url: string;
  name: string;
  default_branch: string;
  primary_language?: string | null;
  local_path?: string | null;
}

/** Indexing run row (abbreviated, for extractor + pipeline consumption). */
export interface IndexingRun {
  id: string;
  tenant_id: string;
  repo_id: string;
  branch: string;
  commit?: string | null;
  status: "running" | "ok" | "error" | "cancelled";
  started_at: string;
  finished_at?: string | null;
  extractor_counts?: Record<string, number>;
  error_msg?: string | null;
}
