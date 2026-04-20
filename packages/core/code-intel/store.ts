/**
 * CodeIntelStore -- typed CRUD over the code-intel schema.
 *
 * Every method is tenant-scoped and respects `deleted_at` by default.
 * Writes take an `indexing_run_id` so rows are always traceable to the
 * run that produced them. `beginIndexingRun()` + `finalizeIndexingRun()`
 * bracket a reindex and soft-delete previous active rows atomically.
 *
 * The store depends only on `IDatabase`, which abstracts bun:sqlite and
 * Postgres. Dialect-specific SQL is kept in one shared place (this file)
 * because Wave 1 queries are simple; richer queries move to per-dialect
 * modules when they diverge.
 */

import type { AppContext } from "../app.js";
import type { IDatabase } from "../database/index.js";
import { randomUUID } from "crypto";
import { MigrationRunner } from "./migration-runner.js";
import { DEFAULT_TENANT_ID } from "./constants.js";
import { TABLE as TENANTS_TABLE } from "./schema/tenants.js";
import { TABLE as WORKSPACES_TABLE } from "./schema/workspaces.js";
import { TABLE as REPOS_TABLE } from "./schema/repos.js";
import { TABLE as RUNS_TABLE } from "./schema/indexing-runs.js";
import { TABLE as FILES_TABLE } from "./schema/files.js";
import { TABLE as SYMBOLS_TABLE } from "./schema/symbols.js";
import { TABLE as CHUNKS_TABLE, FTS_TABLE as CHUNKS_FTS_TABLE } from "./schema/chunks.js";
import { TABLE as EDGES_TABLE } from "./schema/edges.js";
import { TABLE as EXT_REFS_TABLE } from "./schema/external-refs.js";
import { TABLE as EMBEDDINGS_TABLE } from "./schema/embeddings.js";
import { TABLE as DEPS_TABLE } from "./schema/dependencies.js";
import { TABLE as PEOPLE_TABLE } from "./schema/people.js";
import { TABLE as CONTRIB_TABLE } from "./schema/contributions.js";
import { TABLE as HOTSPOTS_TABLE } from "./schema/file-hotspots.js";
import type { ChunkKind, EdgeRelation, EntityKind, SubjectKind, SymbolKind } from "./interfaces/types.js";

// ── Public row types ─────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function jsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface CodeIntelStoreOptions {
  dialect?: "sqlite" | "postgres";
}

export class CodeIntelStore {
  readonly dialect: "sqlite" | "postgres";
  private readonly runner: MigrationRunner;

  constructor(
    private readonly db: IDatabase,
    opts: CodeIntelStoreOptions = {},
  ) {
    this.dialect = opts.dialect ?? "sqlite";
    this.runner = new MigrationRunner(db, this.dialect);
  }

  /** Build a store bound to an AppContext, picking up dialect + db. */
  static fromApp(app: AppContext): CodeIntelStore {
    const url = app.config.database?.url ?? app.config.databaseUrl;
    const dialect: "sqlite" | "postgres" =
      url && (url.startsWith("postgres://") || url.startsWith("postgresql://")) ? "postgres" : "sqlite";
    return new CodeIntelStore(app.db, { dialect });
  }

  /** Idempotent: applies any pending migrations. Safe to call on boot. */
  migrate(opts?: { targetVersion?: number }): void {
    this.runner.migrate(opts);
  }

  /** Migration status (current version + pending). */
  migrationStatus() {
    return this.runner.status();
  }

  /** Drop every code-intel table (dev only). */
  reset(): void {
    this.runner.reset();
  }

  // ── tenants ───────────────────────────────────────────────────────────────

  createTenant(input: { id?: string; name: string; slug: string }): Tenant {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    this.db
      .prepare(`INSERT INTO ${TENANTS_TABLE} (id, name, slug, created_at) VALUES (${this.phs(1, 4)})`)
      .run(id, input.name, input.slug, created_at);
    return { id, name: input.name, slug: input.slug, created_at };
  }

  getTenant(id: string): Tenant | null {
    const row = this.db
      .prepare(`SELECT id, name, slug, created_at FROM ${TENANTS_TABLE} WHERE id = ${this.ph(1)}`)
      .get(id) as Tenant | undefined;
    return row ?? null;
  }

  getTenantBySlug(slug: string): Tenant | null {
    const row = this.db
      .prepare(`SELECT id, name, slug, created_at FROM ${TENANTS_TABLE} WHERE slug = ${this.ph(1)}`)
      .get(slug) as Tenant | undefined;
    return row ?? null;
  }

  listTenants(): Tenant[] {
    return this.db
      .prepare(`SELECT id, name, slug, created_at FROM ${TENANTS_TABLE} ORDER BY created_at ASC`)
      .all() as Tenant[];
  }

  // ── repos ────────────────────────────────────────────────────────────────

  createRepo(input: {
    id?: string;
    tenant_id: string;
    repo_url: string;
    name: string;
    default_branch?: string;
    primary_language?: string | null;
    local_path?: string | null;
    config?: Record<string, unknown>;
  }): Repo {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const default_branch = input.default_branch ?? "main";
    const config = input.config ?? {};
    this.db
      .prepare(
        `INSERT INTO ${REPOS_TABLE} (id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at)
         VALUES (${this.phs(1, 9)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.repo_url,
        input.name,
        default_branch,
        input.primary_language ?? null,
        input.local_path ?? null,
        jsonStringify(config),
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      repo_url: input.repo_url,
      name: input.name,
      default_branch,
      primary_language: input.primary_language ?? null,
      local_path: input.local_path ?? null,
      config,
      created_at,
      deleted_at: null,
    };
  }

  getRepo(tenant_id: string, id: string): Repo | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at, deleted_at
         FROM ${REPOS_TABLE} WHERE tenant_id = ${this.ph(1)} AND id = ${this.ph(2)} AND deleted_at IS NULL`,
      )
      .get(tenant_id, id) as (Omit<Repo, "config"> & { config: string }) | undefined;
    return row ? { ...row, config: jsonParse(row.config, {}) } : null;
  }

  findRepoByUrl(tenant_id: string, repo_url: string): Repo | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at, deleted_at
         FROM ${REPOS_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_url = ${this.ph(2)} AND deleted_at IS NULL`,
      )
      .get(tenant_id, repo_url) as (Omit<Repo, "config"> & { config: string }) | undefined;
    return row ? { ...row, config: jsonParse(row.config, {}) } : null;
  }

  listRepos(tenant_id: string): Repo[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at, deleted_at
         FROM ${REPOS_TABLE} WHERE tenant_id = ${this.ph(1)} AND deleted_at IS NULL ORDER BY name ASC`,
      )
      .all(tenant_id) as Array<Omit<Repo, "config"> & { config: string }>;
    return rows.map((r) => ({ ...r, config: jsonParse(r.config, {}) }));
  }

  softDeleteRepo(tenant_id: string, id: string): void {
    this.db
      .prepare(
        `UPDATE ${REPOS_TABLE} SET deleted_at = ${this.ph(1)} WHERE tenant_id = ${this.ph(2)} AND id = ${this.ph(3)}`,
      )
      .run(nowIso(), tenant_id, id);
  }

  // ── indexing runs ────────────────────────────────────────────────────────

  beginIndexingRun(input: {
    id?: string;
    tenant_id: string;
    repo_id: string;
    branch: string;
    commit_sha?: string | null;
  }): IndexingRun {
    const id = input.id ?? randomUUID();
    const started_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO ${RUNS_TABLE} (id, tenant_id, repo_id, branch, commit_sha, status, extractor_counts, started_at)
         VALUES (${this.phs(1, 8)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.repo_id,
        input.branch,
        input.commit_sha ?? null,
        "running",
        jsonStringify({}),
        started_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      repo_id: input.repo_id,
      branch: input.branch,
      commit_sha: input.commit_sha ?? null,
      status: "running",
      extractor_counts: {},
      error_msg: null,
      started_at,
      finished_at: null,
    };
  }

  /**
   * Finalize a run: mark status + soft-delete every prior active row tagged
   * to a different run for this (tenant, repo). This makes the new run the
   * sole "live" state atomically from the query surface's point of view.
   */
  finalizeIndexingRun(input: {
    run_id: string;
    status: "ok" | "error" | "cancelled";
    extractor_counts?: Record<string, number>;
    error_msg?: string | null;
  }): void {
    const finished_at = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE ${RUNS_TABLE} SET status = ${this.ph(1)}, finished_at = ${this.ph(2)}, extractor_counts = ${this.ph(3)}, error_msg = ${this.ph(4)} WHERE id = ${this.ph(5)}`,
        )
        .run(
          input.status,
          finished_at,
          jsonStringify(input.extractor_counts ?? {}),
          input.error_msg ?? null,
          input.run_id,
        );

      if (input.status !== "ok") return;

      // Find the run we just finalized to identify its (tenant, repo).
      const run = this.db
        .prepare(`SELECT tenant_id, repo_id FROM ${RUNS_TABLE} WHERE id = ${this.ph(1)}`)
        .get(input.run_id) as { tenant_id: string; repo_id: string } | undefined;
      if (!run) return;

      // Tables we soft-delete to let the latest run win. `embeddings` and
      // `external_refs` don't carry deleted_at; leave them alone.
      const tables = [FILES_TABLE, SYMBOLS_TABLE, CHUNKS_TABLE, EDGES_TABLE, DEPS_TABLE, CONTRIB_TABLE, HOTSPOTS_TABLE];
      // Resolve prior runs once so the inner UPDATE doesn't carry a subquery
      // (subqueries with our placeholder helper would double-count parameters).
      const priorRuns = this.db
        .prepare(
          `SELECT id FROM ${RUNS_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)} AND id != ${this.ph(3)}`,
        )
        .all(run.tenant_id, run.repo_id, input.run_id) as Array<{ id: string }>;
      if (priorRuns.length === 0) return;

      for (const t of tables) {
        // Build a `IN (?, ?, ...)` clause sized to the prior-run count.
        const placeholders = priorRuns.map((_, i) => (this.dialect === "sqlite" ? "?" : `$${i + 3}`)).join(", ");
        const sql = `UPDATE ${t} SET deleted_at = ${this.dialect === "sqlite" ? "?" : "$1"}
             WHERE tenant_id = ${this.dialect === "sqlite" ? "?" : "$2"}
               AND deleted_at IS NULL
               AND indexing_run_id IN (${placeholders})`;
        const params = [finished_at, run.tenant_id, ...priorRuns.map((r) => r.id)];
        this.db.prepare(sql).run(...params);
      }
    });
  }

  getIndexingRun(id: string): IndexingRun | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, repo_id, branch, commit_sha, status, extractor_counts, error_msg, started_at, finished_at
         FROM ${RUNS_TABLE} WHERE id = ${this.ph(1)}`,
      )
      .get(id) as (Omit<IndexingRun, "extractor_counts"> & { extractor_counts: string }) | undefined;
    return row ? { ...row, extractor_counts: jsonParse(row.extractor_counts, {}) } : null;
  }

  listIndexingRuns(tenant_id: string, repo_id?: string, limit = 50): IndexingRun[] {
    const rows = repo_id
      ? (this.db
          .prepare(
            `SELECT id, tenant_id, repo_id, branch, commit_sha, status, extractor_counts, error_msg, started_at, finished_at
             FROM ${RUNS_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)}
             ORDER BY started_at DESC, id DESC LIMIT ${this.ph(3)}`,
          )
          .all(tenant_id, repo_id, limit) as Array<
          Omit<IndexingRun, "extractor_counts"> & { extractor_counts: string }
        >)
      : (this.db
          .prepare(
            `SELECT id, tenant_id, repo_id, branch, commit_sha, status, extractor_counts, error_msg, started_at, finished_at
             FROM ${RUNS_TABLE} WHERE tenant_id = ${this.ph(1)} ORDER BY started_at DESC, id DESC LIMIT ${this.ph(2)}`,
          )
          .all(tenant_id, limit) as Array<Omit<IndexingRun, "extractor_counts"> & { extractor_counts: string }>);
    return rows.map((r) => ({ ...r, extractor_counts: jsonParse(r.extractor_counts, {}) }));
  }

  // ── files ────────────────────────────────────────────────────────────────

  insertFile(input: {
    id?: string;
    tenant_id: string;
    repo_id: string;
    path: string;
    sha: string;
    mtime?: string | null;
    language?: string | null;
    size_bytes?: number | null;
    indexing_run_id: string;
  }): FileRow {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO ${FILES_TABLE} (id, tenant_id, repo_id, path, sha, mtime, language, size_bytes, indexing_run_id, created_at)
         VALUES (${this.phs(1, 10)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.repo_id,
        input.path,
        input.sha,
        input.mtime ?? null,
        input.language ?? null,
        input.size_bytes ?? null,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      repo_id: input.repo_id,
      path: input.path,
      sha: input.sha,
      mtime: input.mtime ?? null,
      language: input.language ?? null,
      size_bytes: input.size_bytes ?? null,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  getFile(tenant_id: string, id: string): FileRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ${FILES_TABLE} WHERE tenant_id = ${this.ph(1)} AND id = ${this.ph(2)} AND deleted_at IS NULL`,
      )
      .get(tenant_id, id) as FileRow | undefined;
    return row ?? null;
  }

  listFiles(tenant_id: string, repo_id: string, limit = 1000): FileRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ${FILES_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)} AND deleted_at IS NULL
         ORDER BY path ASC LIMIT ${this.ph(3)}`,
      )
      .all(tenant_id, repo_id, limit) as FileRow[];
  }

  findFileByPath(tenant_id: string, repo_id: string, path: string): FileRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ${FILES_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)} AND path = ${this.ph(3)} AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(tenant_id, repo_id, path) as FileRow | undefined;
    return row ?? null;
  }

  // ── symbols ──────────────────────────────────────────────────────────────

  insertSymbol(input: {
    id?: string;
    tenant_id: string;
    file_id: string;
    kind: SymbolKind;
    name: string;
    fqn?: string | null;
    signature?: string | null;
    line_start?: number | null;
    line_end?: number | null;
    parent_symbol_id?: string | null;
    indexing_run_id: string;
  }): SymbolRow {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO ${SYMBOLS_TABLE} (id, tenant_id, file_id, kind, name, fqn, signature, line_start, line_end, parent_symbol_id, indexing_run_id, created_at)
         VALUES (${this.phs(1, 12)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.file_id,
        input.kind,
        input.name,
        input.fqn ?? null,
        input.signature ?? null,
        input.line_start ?? null,
        input.line_end ?? null,
        input.parent_symbol_id ?? null,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      file_id: input.file_id,
      kind: input.kind,
      name: input.name,
      fqn: input.fqn ?? null,
      signature: input.signature ?? null,
      line_start: input.line_start ?? null,
      line_end: input.line_end ?? null,
      parent_symbol_id: input.parent_symbol_id ?? null,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  listSymbolsByFile(tenant_id: string, file_id: string): SymbolRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ${SYMBOLS_TABLE} WHERE tenant_id = ${this.ph(1)} AND file_id = ${this.ph(2)} AND deleted_at IS NULL ORDER BY line_start ASC`,
      )
      .all(tenant_id, file_id) as SymbolRow[];
  }

  findSymbolByName(tenant_id: string, name: string, limit = 50): SymbolRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ${SYMBOLS_TABLE} WHERE tenant_id = ${this.ph(1)} AND name = ${this.ph(2)} AND deleted_at IS NULL LIMIT ${this.ph(3)}`,
      )
      .all(tenant_id, name, limit) as SymbolRow[];
  }

  // ── chunks ───────────────────────────────────────────────────────────────

  insertChunk(input: {
    id?: string;
    tenant_id: string;
    file_id: string;
    symbol_id?: string | null;
    parent_chunk_id?: string | null;
    chunk_kind?: ChunkKind;
    content: string;
    line_start?: number | null;
    line_end?: number | null;
    attrs?: Record<string, unknown>;
    indexing_run_id: string;
    /** Optional FTS hints (path + symbol name) so search matches file paths + symbol names. */
    path_hint?: string;
    symbol_name?: string;
  }): ChunkRow {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const chunk_kind = input.chunk_kind ?? "code";
    const attrs = input.attrs ?? {};
    this.db
      .prepare(
        `INSERT INTO ${CHUNKS_TABLE} (id, tenant_id, file_id, symbol_id, parent_chunk_id, chunk_kind, content, line_start, line_end, attrs, indexing_run_id, created_at)
         VALUES (${this.phs(1, 12)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.file_id,
        input.symbol_id ?? null,
        input.parent_chunk_id ?? null,
        chunk_kind,
        input.content,
        input.line_start ?? null,
        input.line_end ?? null,
        jsonStringify(attrs),
        input.indexing_run_id,
        created_at,
      );
    // SQLite FTS insert (content-linked table). Postgres uses generated tsvector
    // in the base table already; nothing to do there.
    if (this.dialect === "sqlite") {
      this.db
        .prepare(
          `INSERT INTO ${CHUNKS_FTS_TABLE} (chunk_id, tenant_id, content, path_hint, symbol_name) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, input.tenant_id, input.content, input.path_hint ?? "", input.symbol_name ?? "");
    }
    return {
      id,
      tenant_id: input.tenant_id,
      file_id: input.file_id,
      symbol_id: input.symbol_id ?? null,
      parent_chunk_id: input.parent_chunk_id ?? null,
      chunk_kind,
      content: input.content,
      line_start: input.line_start ?? null,
      line_end: input.line_end ?? null,
      attrs,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  getChunk(tenant_id: string, id: string): ChunkRow | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, file_id, symbol_id, parent_chunk_id, chunk_kind, content, line_start, line_end, attrs, indexing_run_id, created_at, deleted_at
         FROM ${CHUNKS_TABLE} WHERE tenant_id = ${this.ph(1)} AND id = ${this.ph(2)} AND deleted_at IS NULL`,
      )
      .get(tenant_id, id) as (Omit<ChunkRow, "attrs"> & { attrs: string }) | undefined;
    return row ? { ...row, attrs: jsonParse(row.attrs, {}) } : null;
  }

  listChunksByFile(tenant_id: string, file_id: string): ChunkRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, file_id, symbol_id, parent_chunk_id, chunk_kind, content, line_start, line_end, attrs, indexing_run_id, created_at, deleted_at
         FROM ${CHUNKS_TABLE} WHERE tenant_id = ${this.ph(1)} AND file_id = ${this.ph(2)} AND deleted_at IS NULL ORDER BY line_start ASC`,
      )
      .all(tenant_id, file_id) as Array<Omit<ChunkRow, "attrs"> & { attrs: string }>;
    return rows.map((r) => ({ ...r, attrs: jsonParse(r.attrs, {}) }));
  }

  /**
   * Simple FTS over chunks. SQLite uses fts5 MATCH; Postgres falls back to
   * plainto_tsquery against the generated tsvector column.
   */
  searchChunks(tenant_id: string, query: string, limit = 50): Array<ChunkRow & { match_score: number }> {
    if (this.dialect === "sqlite") {
      const rows = this.db
        .prepare(
          `SELECT c.id, c.tenant_id, c.file_id, c.symbol_id, c.parent_chunk_id, c.chunk_kind, c.content, c.line_start, c.line_end, c.attrs, c.indexing_run_id, c.created_at, c.deleted_at, bm25(${CHUNKS_FTS_TABLE}) AS match_score
           FROM ${CHUNKS_FTS_TABLE} f JOIN ${CHUNKS_TABLE} c ON c.id = f.chunk_id
           WHERE f.tenant_id = ? AND ${CHUNKS_FTS_TABLE} MATCH ? AND c.deleted_at IS NULL
           ORDER BY match_score ASC LIMIT ?`,
        )
        .all(tenant_id, sanitizeFtsQuery(query), limit) as Array<
        Omit<ChunkRow, "attrs"> & { attrs: string; match_score: number }
      >;
      return rows.map((r) => ({ ...r, attrs: jsonParse(r.attrs, {}) }));
    }
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, file_id, symbol_id, parent_chunk_id, chunk_kind, content, line_start, line_end, attrs, indexing_run_id, created_at, deleted_at,
                ts_rank(fts_tsv, plainto_tsquery('english', $2)) AS match_score
         FROM ${CHUNKS_TABLE}
         WHERE tenant_id = $1 AND fts_tsv @@ plainto_tsquery('english', $2) AND deleted_at IS NULL
         ORDER BY match_score DESC LIMIT $3`,
      )
      .all(tenant_id, query, limit) as Array<Omit<ChunkRow, "attrs"> & { attrs: string; match_score: number }>;
    return rows.map((r) => ({ ...r, attrs: jsonParse(r.attrs, {}) }));
  }

  // ── edges ────────────────────────────────────────────────────────────────

  insertEdge(input: {
    id?: string;
    tenant_id: string;
    source_kind: EntityKind;
    source_id: string;
    target_kind: EntityKind;
    target_id: string;
    relation: EdgeRelation;
    evidence_chunk_id?: string | null;
    weight?: number;
    attrs?: Record<string, unknown>;
    indexing_run_id: string;
  }): EdgeRow {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const weight = input.weight ?? 1.0;
    const attrs = input.attrs ?? {};
    this.db
      .prepare(
        `INSERT INTO ${EDGES_TABLE} (id, tenant_id, source_kind, source_id, target_kind, target_id, relation, evidence_chunk_id, weight, attrs, indexing_run_id, created_at)
         VALUES (${this.phs(1, 12)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.source_kind,
        input.source_id,
        input.target_kind,
        input.target_id,
        input.relation,
        input.evidence_chunk_id ?? null,
        weight,
        jsonStringify(attrs),
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      source_kind: input.source_kind,
      source_id: input.source_id,
      target_kind: input.target_kind,
      target_id: input.target_id,
      relation: input.relation,
      evidence_chunk_id: input.evidence_chunk_id ?? null,
      weight,
      attrs,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  listEdgesFrom(tenant_id: string, source_kind: EntityKind, source_id: string): EdgeRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, source_kind, source_id, target_kind, target_id, relation, evidence_chunk_id, weight, attrs, indexing_run_id, created_at, deleted_at
         FROM ${EDGES_TABLE} WHERE tenant_id = ${this.ph(1)} AND source_kind = ${this.ph(2)} AND source_id = ${this.ph(3)} AND deleted_at IS NULL`,
      )
      .all(tenant_id, source_kind, source_id) as Array<Omit<EdgeRow, "attrs"> & { attrs: string }>;
    return rows.map((r) => ({ ...r, attrs: jsonParse(r.attrs, {}) }));
  }

  listEdgesTo(tenant_id: string, target_kind: EntityKind, target_id: string): EdgeRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, source_kind, source_id, target_kind, target_id, relation, evidence_chunk_id, weight, attrs, indexing_run_id, created_at, deleted_at
         FROM ${EDGES_TABLE} WHERE tenant_id = ${this.ph(1)} AND target_kind = ${this.ph(2)} AND target_id = ${this.ph(3)} AND deleted_at IS NULL`,
      )
      .all(tenant_id, target_kind, target_id) as Array<Omit<EdgeRow, "attrs"> & { attrs: string }>;
    return rows.map((r) => ({ ...r, attrs: jsonParse(r.attrs, {}) }));
  }

  // ── external_refs ────────────────────────────────────────────────────────

  insertExternalRef(input: {
    id?: string;
    tenant_id: string;
    symbol_id: string;
    external_repo_hint?: string | null;
    external_fqn: string;
    indexing_run_id: string;
  }): ExternalRefRow {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO ${EXT_REFS_TABLE} (id, tenant_id, symbol_id, external_repo_hint, external_fqn, indexing_run_id, created_at)
         VALUES (${this.phs(1, 7)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.symbol_id,
        input.external_repo_hint ?? null,
        input.external_fqn,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      symbol_id: input.symbol_id,
      external_repo_hint: input.external_repo_hint ?? null,
      external_fqn: input.external_fqn,
      resolved_symbol_id: null,
      resolved_at: null,
      indexing_run_id: input.indexing_run_id,
      created_at,
    };
  }

  listExternalRefs(tenant_id: string, onlyUnresolved = false): ExternalRefRow[] {
    const sql = onlyUnresolved
      ? `SELECT * FROM ${EXT_REFS_TABLE} WHERE tenant_id = ${this.ph(1)} AND resolved_symbol_id IS NULL`
      : `SELECT * FROM ${EXT_REFS_TABLE} WHERE tenant_id = ${this.ph(1)}`;
    return this.db.prepare(sql).all(tenant_id) as ExternalRefRow[];
  }

  // ── embeddings ───────────────────────────────────────────────────────────

  insertEmbedding(input: {
    id?: string;
    tenant_id: string;
    subject_kind: SubjectKind;
    subject_id: string;
    model: string;
    model_version: string;
    dim: number;
    vector: Uint8Array;
    indexing_run_id: string;
  }): EmbeddingRow {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO ${EMBEDDINGS_TABLE} (id, tenant_id, subject_kind, subject_id, model, model_version, dim, vector, indexing_run_id, created_at)
         VALUES (${this.phs(1, 10)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.subject_kind,
        input.subject_id,
        input.model,
        input.model_version,
        input.dim,
        input.vector,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      model: input.model,
      model_version: input.model_version,
      dim: input.dim,
      vector: input.vector,
      indexing_run_id: input.indexing_run_id,
      created_at,
    };
  }

  getEmbedding(
    tenant_id: string,
    subject_kind: SubjectKind,
    subject_id: string,
    model: string,
    model_version: string,
  ): EmbeddingRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ${EMBEDDINGS_TABLE} WHERE tenant_id = ${this.ph(1)} AND subject_kind = ${this.ph(2)} AND subject_id = ${this.ph(3)} AND model = ${this.ph(4)} AND model_version = ${this.ph(5)}`,
      )
      .get(tenant_id, subject_kind, subject_id, model, model_version) as EmbeddingRow | undefined;
    return row ?? null;
  }

  // ── dependencies ─────────────────────────────────────────────────────────

  insertDependency(input: {
    id?: string;
    tenant_id: string;
    repo_id: string;
    file_id?: string | null;
    manifest_kind: string;
    name: string;
    version_constraint?: string | null;
    resolved_version?: string | null;
    dep_type?: "prod" | "dev" | "peer" | "optional";
    indexing_run_id: string;
  }): DependencyRow {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const dep_type = input.dep_type ?? "prod";
    this.db
      .prepare(
        `INSERT INTO ${DEPS_TABLE} (id, tenant_id, repo_id, file_id, manifest_kind, name, version_constraint, resolved_version, dep_type, indexing_run_id, created_at)
         VALUES (${this.phs(1, 11)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.repo_id,
        input.file_id ?? null,
        input.manifest_kind,
        input.name,
        input.version_constraint ?? null,
        input.resolved_version ?? null,
        dep_type,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      repo_id: input.repo_id,
      file_id: input.file_id ?? null,
      manifest_kind: input.manifest_kind,
      name: input.name,
      version_constraint: input.version_constraint ?? null,
      resolved_version: input.resolved_version ?? null,
      dep_type,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  listDependencies(tenant_id: string, repo_id: string): DependencyRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ${DEPS_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)} AND deleted_at IS NULL ORDER BY manifest_kind, name`,
      )
      .all(tenant_id, repo_id) as DependencyRow[];
  }

  // ── people ───────────────────────────────────────────────────────────────

  upsertPerson(input: {
    id?: string;
    tenant_id: string;
    primary_email: string;
    name?: string | null;
    alt_emails?: string[];
    alt_names?: string[];
  }): PersonRow {
    const existing = this.db
      .prepare(
        `SELECT id, tenant_id, primary_email, name, alt_emails, alt_names, created_at FROM ${PEOPLE_TABLE}
         WHERE tenant_id = ${this.ph(1)} AND primary_email = ${this.ph(2)}`,
      )
      .get(input.tenant_id, input.primary_email) as
      | (Omit<PersonRow, "alt_emails" | "alt_names"> & { alt_emails: string; alt_names: string })
      | undefined;
    if (existing) {
      return {
        ...existing,
        alt_emails: jsonParse(existing.alt_emails, [] as string[]),
        alt_names: jsonParse(existing.alt_names, [] as string[]),
      };
    }
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const alt_emails = input.alt_emails ?? [];
    const alt_names = input.alt_names ?? [];
    this.db
      .prepare(
        `INSERT INTO ${PEOPLE_TABLE} (id, tenant_id, primary_email, name, alt_emails, alt_names, created_at) VALUES (${this.phs(1, 7)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.primary_email,
        input.name ?? null,
        jsonStringify(alt_emails),
        jsonStringify(alt_names),
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      primary_email: input.primary_email,
      name: input.name ?? null,
      alt_emails,
      alt_names,
      created_at,
    };
  }

  listPeople(tenant_id: string): PersonRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, primary_email, name, alt_emails, alt_names, created_at FROM ${PEOPLE_TABLE} WHERE tenant_id = ${this.ph(1)} ORDER BY name`,
      )
      .all(tenant_id) as Array<Omit<PersonRow, "alt_emails" | "alt_names"> & { alt_emails: string; alt_names: string }>;
    return rows.map((r) => ({
      ...r,
      alt_emails: jsonParse(r.alt_emails, [] as string[]),
      alt_names: jsonParse(r.alt_names, [] as string[]),
    }));
  }

  // ── contributions ───────────────────────────────────────────────────────

  insertContribution(input: {
    id?: string;
    tenant_id: string;
    person_id: string;
    repo_id: string;
    file_id?: string | null;
    commit_count?: number;
    loc_added?: number;
    loc_removed?: number;
    first_commit?: string | null;
    last_commit?: string | null;
    indexing_run_id: string;
  }): ContributionRow {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const commit_count = input.commit_count ?? 0;
    const loc_added = input.loc_added ?? 0;
    const loc_removed = input.loc_removed ?? 0;
    this.db
      .prepare(
        `INSERT INTO ${CONTRIB_TABLE} (id, tenant_id, person_id, repo_id, file_id, commit_count, loc_added, loc_removed, first_commit, last_commit, indexing_run_id, created_at)
         VALUES (${this.phs(1, 12)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.person_id,
        input.repo_id,
        input.file_id ?? null,
        commit_count,
        loc_added,
        loc_removed,
        input.first_commit ?? null,
        input.last_commit ?? null,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      person_id: input.person_id,
      repo_id: input.repo_id,
      file_id: input.file_id ?? null,
      commit_count,
      loc_added,
      loc_removed,
      first_commit: input.first_commit ?? null,
      last_commit: input.last_commit ?? null,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  listContributionsForRepo(tenant_id: string, repo_id: string, limit = 100): ContributionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ${CONTRIB_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)} AND file_id IS NULL AND deleted_at IS NULL
         ORDER BY commit_count DESC LIMIT ${this.ph(3)}`,
      )
      .all(tenant_id, repo_id, limit) as ContributionRow[];
  }

  listContributionsForFile(tenant_id: string, file_id: string, limit = 20): ContributionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ${CONTRIB_TABLE} WHERE tenant_id = ${this.ph(1)} AND file_id = ${this.ph(2)} AND deleted_at IS NULL
         ORDER BY commit_count DESC LIMIT ${this.ph(3)}`,
      )
      .all(tenant_id, file_id, limit) as ContributionRow[];
  }

  // ── hotspots ─────────────────────────────────────────────────────────────

  insertHotspot(input: {
    id?: string;
    tenant_id: string;
    file_id: string;
    change_count_30d: number;
    change_count_90d: number;
    authors_count: number;
    lines_touched: number;
    risk_score: number;
    indexing_run_id: string;
  }): HotspotRow {
    const id = input.id ?? randomUUID();
    const computed_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO ${HOTSPOTS_TABLE} (id, tenant_id, file_id, change_count_30d, change_count_90d, authors_count, lines_touched, risk_score, computed_at, indexing_run_id)
         VALUES (${this.phs(1, 10)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.file_id,
        input.change_count_30d,
        input.change_count_90d,
        input.authors_count,
        input.lines_touched,
        input.risk_score,
        computed_at,
        input.indexing_run_id,
      );
    return { ...input, id, computed_at, deleted_at: null };
  }

  getHotspotForFile(tenant_id: string, file_id: string): HotspotRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ${HOTSPOTS_TABLE} WHERE tenant_id = ${this.ph(1)} AND file_id = ${this.ph(2)} AND deleted_at IS NULL ORDER BY computed_at DESC LIMIT 1`,
      )
      .get(tenant_id, file_id) as HotspotRow | undefined;
    return row ?? null;
  }

  // ── workspaces (Wave 2a) ─────────────────────────────────────────────────

  createWorkspace(input: {
    id?: string;
    tenant_id: string;
    slug: string;
    name: string;
    description?: string | null;
    config?: Record<string, unknown>;
  }): Workspace {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const description = input.description ?? null;
    const config = input.config ?? {};
    this.db
      .prepare(
        `INSERT INTO ${WORKSPACES_TABLE} (id, tenant_id, slug, name, description, config, created_at)
         VALUES (${this.phs(1, 7)})`,
      )
      .run(id, input.tenant_id, input.slug, input.name, description, jsonStringify(config), created_at);
    return {
      id,
      tenant_id: input.tenant_id,
      slug: input.slug,
      name: input.name,
      description,
      config,
      created_at,
      deleted_at: null,
    };
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, slug, name, description, config, created_at, deleted_at
         FROM ${WORKSPACES_TABLE} WHERE id = ${this.ph(1)} AND deleted_at IS NULL`,
      )
      .get(id) as (Omit<Workspace, "config"> & { config: string }) | undefined;
    return row ? { ...row, config: jsonParse(row.config, {}) } : null;
  }

  getWorkspaceBySlug(tenant_id: string, slug: string): Workspace | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, slug, name, description, config, created_at, deleted_at
         FROM ${WORKSPACES_TABLE} WHERE tenant_id = ${this.ph(1)} AND slug = ${this.ph(2)} AND deleted_at IS NULL`,
      )
      .get(tenant_id, slug) as (Omit<Workspace, "config"> & { config: string }) | undefined;
    return row ? { ...row, config: jsonParse(row.config, {}) } : null;
  }

  listWorkspaces(tenant_id: string): Workspace[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, slug, name, description, config, created_at, deleted_at
         FROM ${WORKSPACES_TABLE} WHERE tenant_id = ${this.ph(1)} AND deleted_at IS NULL ORDER BY slug ASC`,
      )
      .all(tenant_id) as Array<Omit<Workspace, "config"> & { config: string }>;
    return rows.map((r) => ({ ...r, config: jsonParse(r.config, {}) }));
  }

  /**
   * Soft-delete a workspace. Does not cascade to repos. If any repo still
   * points at the workspace, the call throws unless `force: true` is passed;
   * with `force`, repos are detached (`workspace_id = NULL`) and the
   * workspace is marked deleted.
   */
  softDeleteWorkspace(id: string, opts: { force?: boolean } = {}): void {
    const attached = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${REPOS_TABLE} WHERE workspace_id = ${this.ph(1)} AND deleted_at IS NULL`)
      .get(id) as { n: number } | undefined;
    const attachedCount = attached?.n ?? 0;
    if (attachedCount > 0 && !opts.force) {
      throw new Error(
        `workspace ${id} still has ${attachedCount} attached repo(s); pass {force: true} to detach + delete`,
      );
    }
    const now = nowIso();
    this.db.transaction(() => {
      if (attachedCount > 0) {
        this.db.prepare(`UPDATE ${REPOS_TABLE} SET workspace_id = NULL WHERE workspace_id = ${this.ph(1)}`).run(id);
      }
      this.db
        .prepare(`UPDATE ${WORKSPACES_TABLE} SET deleted_at = ${this.ph(1)} WHERE id = ${this.ph(2)}`)
        .run(now, id);
    });
  }

  /** Attach a repo to a workspace. Both must belong to the same tenant. */
  addRepoToWorkspace(repo_id: string, workspace_id: string): void {
    const repo = this.db.prepare(`SELECT tenant_id FROM ${REPOS_TABLE} WHERE id = ${this.ph(1)}`).get(repo_id) as
      | { tenant_id: string }
      | undefined;
    if (!repo) throw new Error(`repo ${repo_id} not found`);
    const ws = this.db
      .prepare(`SELECT tenant_id FROM ${WORKSPACES_TABLE} WHERE id = ${this.ph(1)} AND deleted_at IS NULL`)
      .get(workspace_id) as { tenant_id: string } | undefined;
    if (!ws) throw new Error(`workspace ${workspace_id} not found`);
    if (repo.tenant_id !== ws.tenant_id) {
      throw new Error(`repo and workspace belong to different tenants`);
    }
    this.db
      .prepare(`UPDATE ${REPOS_TABLE} SET workspace_id = ${this.ph(1)} WHERE id = ${this.ph(2)}`)
      .run(workspace_id, repo_id);
  }

  /** Detach a repo from whatever workspace currently owns it. */
  removeRepoFromWorkspace(repo_id: string): void {
    this.db.prepare(`UPDATE ${REPOS_TABLE} SET workspace_id = NULL WHERE id = ${this.ph(1)}`).run(repo_id);
  }

  /** Return `workspace_id` for a repo (null if unattached or unknown). */
  getRepoWorkspaceId(repo_id: string): string | null {
    const row = this.db.prepare(`SELECT workspace_id FROM ${REPOS_TABLE} WHERE id = ${this.ph(1)}`).get(repo_id) as
      | { workspace_id: string | null }
      | undefined;
    return row?.workspace_id ?? null;
  }

  /** List repos attached to a workspace. Tenant-scoped to belt-and-braces. */
  listReposInWorkspace(tenant_id: string, workspace_id: string): Repo[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at, deleted_at
         FROM ${REPOS_TABLE} WHERE tenant_id = ${this.ph(1)} AND workspace_id = ${this.ph(2)} AND deleted_at IS NULL
         ORDER BY name ASC`,
      )
      .all(tenant_id, workspace_id) as Array<Omit<Repo, "config"> & { config: string }>;
    return rows.map((r) => ({ ...r, config: jsonParse(r.config, {}) }));
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * Render a single placeholder at logical position `index` (1-based).
   *
   * SQLite always returns `?` (positional anonymous binding).
   * Postgres returns `$N` so the same call site works for both dialects.
   *
   * For comma-separated `(?, ?, ?, ?)` use `phs(start, count)` instead.
   */
  private ph(index: number): string {
    return this.dialect === "sqlite" ? "?" : `$${index}`;
  }

  /** Produce `count` placeholders separated by ", " starting at `start`. */
  private phs(start: number, count: number): string {
    return Array.from({ length: count }, (_, i) => this.ph(start + i)).join(", ");
  }
}

export { DEFAULT_TENANT_ID };

/** Escape / quote the FTS query so user input can't break the MATCH grammar. */
function sanitizeFtsQuery(q: string): string {
  const cleaned = q
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  if (cleaned.length === 0) return '""';
  return cleaned.join(" ");
}
