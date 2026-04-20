/**
 * Schema registry -- one module per table, each exporting `sqliteDDL()` +
 * `postgresDDL()` emitters. The migration runner consumes this registry
 * in deterministic order so fresh applies and re-runs produce identical
 * state.
 *
 * TODO(wave 2): add the following tables:
 *   - endpoints              (per-framework HTTP routes)
 *   - configs                (parsed config entries)
 *   - infra_resources        (k8s / terraform / docker-compose / helm)
 *   - test_mappings          (test file <-> source file associations)
 *   - semantic_annotations   (LLM-generated intent summaries, D1)
 *   - contracts              (function contract extraction, D4)
 *   - test_assertions        (test intent graph, D5)
 */

import * as tenants from "./tenants.js";
import * as schemaMigrations from "./schema-migrations.js";
import * as workspaces from "./workspaces.js";
import * as repos from "./repos.js";
import * as indexingRuns from "./indexing-runs.js";
import * as files from "./files.js";
import * as symbols from "./symbols.js";
import * as chunks from "./chunks.js";
import * as edges from "./edges.js";
import * as externalRefs from "./external-refs.js";
import * as embeddings from "./embeddings.js";
import * as dependencies from "./dependencies.js";
import * as people from "./people.js";
import * as contributions from "./contributions.js";
import * as fileHotspots from "./file-hotspots.js";
import * as platformDocs from "./platform-docs.js";
import * as platformDocVersions from "./platform-doc-versions.js";

export interface TableModule {
  TABLE: string;
  sqliteDDL(): string;
  postgresDDL(): string;
}

/**
 * Ordered list of table modules.
 *
 * Order is observation-only in SQLite (no FKs); Postgres migrations will
 * respect this order for the eventual FK declarations.
 */
export const TABLE_MODULES: ReadonlyArray<TableModule> = [
  tenants,
  schemaMigrations,
  workspaces,
  repos,
  indexingRuns,
  files,
  symbols,
  chunks,
  edges,
  externalRefs,
  embeddings,
  dependencies,
  people,
  contributions,
  fileHotspots,
];

/**
 * Wave 2c -- platform-docs tables. Intentionally kept OUT of the initial
 * schema aggregate (migration 001 applies `TABLE_MODULES` wholesale; these
 * tables belong to migration 003). Both modules are still exported for
 * direct use from migration 003 + the store.
 */
export const WAVE_2C_TABLE_MODULES: ReadonlyArray<TableModule> = [platformDocs, platformDocVersions];

/** Concatenate all SQLite DDL into one script (for migration runner). */
export function sqliteSchema(): string {
  return TABLE_MODULES.map((m) => m.sqliteDDL()).join("\n");
}

/** Concatenate all Postgres DDL into one script. */
export function postgresSchema(): string {
  return TABLE_MODULES.map((m) => m.postgresDDL()).join("\n");
}

export {
  tenants,
  schemaMigrations,
  workspaces,
  repos,
  indexingRuns,
  files,
  symbols,
  chunks,
  edges,
  externalRefs,
  embeddings,
  dependencies,
  people,
  contributions,
  fileHotspots,
  platformDocs,
  platformDocVersions,
};
