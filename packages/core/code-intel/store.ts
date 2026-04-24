/**
 * CodeIntelStore -- typed CRUD over the code-intel schema.
 *
 * Every method is tenant-scoped and respects `deleted_at` by default.
 * Writes take an `indexing_run_id` so rows are always traceable to the
 * run that produced them. `beginIndexingRun()` + `finalizeIndexingRun()`
 * bracket a reindex and soft-delete previous active rows atomically.
 *
 * The store depends only on `DatabaseAdapter`, which abstracts bun:sqlite and
 * Postgres. Dialect-specific SQL is kept in one shared place (the sub-stores
 * under `store/`) because Wave 1 queries are simple; richer queries move to
 * per-dialect modules when they diverge.
 *
 * This file is a *facade*: the per-concern repositories under `store/` hold
 * the SQL; `CodeIntelStore` composes them and delegates so every existing
 * call site keeps working unchanged. Row types + JSON helpers live in
 * `store/types.ts` and are re-exported here for back-compat.
 *
 * Every method is async: PR 1 of the async-DB refactor flipped DatabaseAdapter
 * to async, and this store passes the calls straight through.
 */

import type { AppContext } from "../app.js";
import type { DatabaseAdapter } from "../database/index.js";
import { MigrationRunner } from "./migration-runner.js";
import { DEFAULT_TENANT_ID } from "./constants.js";
import type { ChunkKind, EdgeRelation, EntityKind, SubjectKind, SymbolKind } from "./interfaces/types.js";
import type { PlatformDocFlavor } from "./interfaces/platform-doc-extractor.js";

import { TenantsRepo } from "./store/tenants.js";
import { ReposRepo } from "./store/repos.js";
import { IndexingRunsRepo } from "./store/indexing-runs.js";
import { FilesRepo, SymbolsRepo } from "./store/files-symbols.js";
import { ChunksRepo } from "./store/chunks.js";
import { EdgesRepo, EmbeddingsRepo, ExternalRefsRepo } from "./store/graph.js";
import { ContributionsRepo, DependenciesRepo, HotspotsRepo, PeopleRepo } from "./store/git-signals.js";
import { WorkspacesRepo } from "./store/workspaces.js";
import { PlatformDocsRepo } from "./store/platform-docs.js";

// Re-export row types from the split module so existing imports keep working
// unchanged (`import type { FileRow } from "./code-intel/store.js"` etc.).
export type {
  Tenant,
  Workspace,
  Repo,
  IndexingRun,
  FileRow,
  SymbolRow,
  ChunkRow,
  EdgeRow,
  ExternalRefRow,
  EmbeddingRow,
  DependencyRow,
  PersonRow,
  ContributionRow,
  HotspotRow,
  PlatformDoc,
  PlatformDocVersion,
} from "./store/types.js";

import type {
  ChunkRow,
  ContributionRow,
  DependencyRow,
  EdgeRow,
  EmbeddingRow,
  ExternalRefRow,
  FileRow,
  HotspotRow,
  IndexingRun,
  PersonRow,
  PlatformDoc,
  PlatformDocVersion,
  Repo,
  SymbolRow,
  Tenant,
  Workspace,
} from "./store/types.js";

export interface CodeIntelStoreOptions {
  dialect?: "sqlite" | "postgres";
}

export class CodeIntelStore {
  readonly dialect: "sqlite" | "postgres";
  private readonly runner: MigrationRunner;

  private readonly tenants: TenantsRepo;
  private readonly repos: ReposRepo;
  private readonly runs: IndexingRunsRepo;
  private readonly files: FilesRepo;
  private readonly symbols: SymbolsRepo;
  private readonly chunks: ChunksRepo;
  private readonly edges: EdgesRepo;
  private readonly externalRefs: ExternalRefsRepo;
  private readonly embeddings: EmbeddingsRepo;
  private readonly deps: DependenciesRepo;
  private readonly people: PeopleRepo;
  private readonly contributions: ContributionsRepo;
  private readonly hotspots: HotspotsRepo;
  private readonly workspaces: WorkspacesRepo;
  private readonly docs: PlatformDocsRepo;

  constructor(db: DatabaseAdapter, opts: CodeIntelStoreOptions = {}) {
    this.dialect = opts.dialect ?? "sqlite";
    this.runner = new MigrationRunner(db, this.dialect);

    this.tenants = new TenantsRepo(db, this.dialect);
    this.repos = new ReposRepo(db, this.dialect);
    this.runs = new IndexingRunsRepo(db, this.dialect);
    this.files = new FilesRepo(db, this.dialect);
    this.symbols = new SymbolsRepo(db, this.dialect);
    this.chunks = new ChunksRepo(db, this.dialect);
    this.edges = new EdgesRepo(db, this.dialect);
    this.externalRefs = new ExternalRefsRepo(db, this.dialect);
    this.embeddings = new EmbeddingsRepo(db, this.dialect);
    this.deps = new DependenciesRepo(db, this.dialect);
    this.people = new PeopleRepo(db, this.dialect);
    this.contributions = new ContributionsRepo(db, this.dialect);
    this.hotspots = new HotspotsRepo(db, this.dialect);
    this.workspaces = new WorkspacesRepo(db, this.dialect);
    this.docs = new PlatformDocsRepo(db, this.dialect);
  }

  /** Build a store bound to an AppContext, picking up dialect + db. */
  static fromApp(app: AppContext): CodeIntelStore {
    return new CodeIntelStore(app.db, { dialect: app.mode.database.dialect });
  }

  // -- migrations -----------------------------------------------------------

  /** Idempotent: applies any pending migrations. Safe to call on boot. */
  async migrate(opts?: { targetVersion?: number }): Promise<void> {
    await this.runner.migrate(opts);
  }

  /** Migration status (current version + pending). */
  async migrationStatus() {
    return this.runner.status();
  }

  /** Drop every code-intel table (dev only). */
  async reset(): Promise<void> {
    await this.runner.reset();
  }

  // -- tenants --------------------------------------------------------------

  createTenant(input: { id?: string; name: string; slug: string }): Promise<Tenant> {
    return this.tenants.createTenant(input);
  }
  getTenant(id: string): Promise<Tenant | null> {
    return this.tenants.getTenant(id);
  }
  getTenantBySlug(slug: string): Promise<Tenant | null> {
    return this.tenants.getTenantBySlug(slug);
  }
  listTenants(): Promise<Tenant[]> {
    return this.tenants.listTenants();
  }

  // -- repos ----------------------------------------------------------------

  createRepo(input: {
    id?: string;
    tenant_id: string;
    repo_url: string;
    name: string;
    default_branch?: string;
    primary_language?: string | null;
    local_path?: string | null;
    config?: Record<string, unknown>;
  }): Promise<Repo> {
    return this.repos.createRepo(input);
  }
  getRepo(tenant_id: string, id: string): Promise<Repo | null> {
    return this.repos.getRepo(tenant_id, id);
  }
  findRepoByUrl(tenant_id: string, repo_url: string): Promise<Repo | null> {
    return this.repos.findRepoByUrl(tenant_id, repo_url);
  }
  listRepos(tenant_id: string): Promise<Repo[]> {
    return this.repos.listRepos(tenant_id);
  }
  softDeleteRepo(tenant_id: string, id: string): Promise<void> {
    return this.repos.softDeleteRepo(tenant_id, id);
  }

  // -- indexing runs --------------------------------------------------------

  beginIndexingRun(input: {
    id?: string;
    tenant_id: string;
    repo_id: string;
    branch: string;
    commit_sha?: string | null;
  }): Promise<IndexingRun> {
    return this.runs.beginIndexingRun(input);
  }
  finalizeIndexingRun(input: {
    run_id: string;
    status: "ok" | "error" | "cancelled";
    extractor_counts?: Record<string, number>;
    error_msg?: string | null;
  }): Promise<void> {
    return this.runs.finalizeIndexingRun(input);
  }
  getIndexingRun(id: string): Promise<IndexingRun | null> {
    return this.runs.getIndexingRun(id);
  }
  listIndexingRuns(tenant_id: string, repo_id?: string, limit = 50): Promise<IndexingRun[]> {
    return this.runs.listIndexingRuns(tenant_id, repo_id, limit);
  }

  // -- files ----------------------------------------------------------------

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
  }): Promise<FileRow> {
    return this.files.insertFile(input);
  }
  getFile(tenant_id: string, id: string): Promise<FileRow | null> {
    return this.files.getFile(tenant_id, id);
  }
  listFiles(tenant_id: string, repo_id: string, limit = 1000): Promise<FileRow[]> {
    return this.files.listFiles(tenant_id, repo_id, limit);
  }
  findFileByPath(tenant_id: string, repo_id: string, path: string): Promise<FileRow | null> {
    return this.files.findFileByPath(tenant_id, repo_id, path);
  }

  // -- symbols --------------------------------------------------------------

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
  }): Promise<SymbolRow> {
    return this.symbols.insertSymbol(input);
  }
  listSymbolsByFile(tenant_id: string, file_id: string): Promise<SymbolRow[]> {
    return this.symbols.listSymbolsByFile(tenant_id, file_id);
  }
  findSymbolByName(tenant_id: string, name: string, limit = 50): Promise<SymbolRow[]> {
    return this.symbols.findSymbolByName(tenant_id, name, limit);
  }

  // -- chunks ---------------------------------------------------------------

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
    path_hint?: string;
    symbol_name?: string;
  }): Promise<ChunkRow> {
    return this.chunks.insertChunk(input);
  }
  getChunk(tenant_id: string, id: string): Promise<ChunkRow | null> {
    return this.chunks.getChunk(tenant_id, id);
  }
  listChunksByFile(tenant_id: string, file_id: string): Promise<ChunkRow[]> {
    return this.chunks.listChunksByFile(tenant_id, file_id);
  }
  searchChunks(tenant_id: string, query: string, limit = 50): Promise<Array<ChunkRow & { match_score: number }>> {
    return this.chunks.searchChunks(tenant_id, query, limit);
  }

  // -- edges ----------------------------------------------------------------

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
  }): Promise<EdgeRow> {
    return this.edges.insertEdge(input);
  }
  listEdgesFrom(tenant_id: string, source_kind: EntityKind, source_id: string): Promise<EdgeRow[]> {
    return this.edges.listEdgesFrom(tenant_id, source_kind, source_id);
  }
  listEdgesTo(tenant_id: string, target_kind: EntityKind, target_id: string): Promise<EdgeRow[]> {
    return this.edges.listEdgesTo(tenant_id, target_kind, target_id);
  }

  // -- external_refs --------------------------------------------------------

  insertExternalRef(input: {
    id?: string;
    tenant_id: string;
    symbol_id: string;
    external_repo_hint?: string | null;
    external_fqn: string;
    indexing_run_id: string;
  }): Promise<ExternalRefRow> {
    return this.externalRefs.insertExternalRef(input);
  }
  listExternalRefs(tenant_id: string, onlyUnresolved = false): Promise<ExternalRefRow[]> {
    return this.externalRefs.listExternalRefs(tenant_id, onlyUnresolved);
  }

  // -- embeddings -----------------------------------------------------------

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
  }): Promise<EmbeddingRow> {
    return this.embeddings.insertEmbedding(input);
  }
  getEmbedding(
    tenant_id: string,
    subject_kind: SubjectKind,
    subject_id: string,
    model: string,
    model_version: string,
  ): Promise<EmbeddingRow | null> {
    return this.embeddings.getEmbedding(tenant_id, subject_kind, subject_id, model, model_version);
  }

  // -- dependencies ---------------------------------------------------------

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
  }): Promise<DependencyRow> {
    return this.deps.insertDependency(input);
  }
  listDependencies(tenant_id: string, repo_id: string): Promise<DependencyRow[]> {
    return this.deps.listDependencies(tenant_id, repo_id);
  }

  // -- people ---------------------------------------------------------------

  upsertPerson(input: {
    id?: string;
    tenant_id: string;
    primary_email: string;
    name?: string | null;
    alt_emails?: string[];
    alt_names?: string[];
  }): Promise<PersonRow> {
    return this.people.upsertPerson(input);
  }
  listPeople(tenant_id: string): Promise<PersonRow[]> {
    return this.people.listPeople(tenant_id);
  }

  // -- contributions --------------------------------------------------------

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
  }): Promise<ContributionRow> {
    return this.contributions.insertContribution(input);
  }
  listContributionsForRepo(tenant_id: string, repo_id: string, limit = 100): Promise<ContributionRow[]> {
    return this.contributions.listContributionsForRepo(tenant_id, repo_id, limit);
  }
  listContributionsForFile(tenant_id: string, file_id: string, limit = 20): Promise<ContributionRow[]> {
    return this.contributions.listContributionsForFile(tenant_id, file_id, limit);
  }

  // -- hotspots -------------------------------------------------------------

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
  }): Promise<HotspotRow> {
    return this.hotspots.insertHotspot(input);
  }
  getHotspotForFile(tenant_id: string, file_id: string): Promise<HotspotRow | null> {
    return this.hotspots.getHotspotForFile(tenant_id, file_id);
  }

  // -- workspaces (Wave 2a) -------------------------------------------------

  createWorkspace(input: {
    id?: string;
    tenant_id: string;
    slug: string;
    name: string;
    description?: string | null;
    config?: Record<string, unknown>;
  }): Promise<Workspace> {
    return this.workspaces.createWorkspace(input);
  }
  getWorkspace(id: string): Promise<Workspace | null> {
    return this.workspaces.getWorkspace(id);
  }
  getWorkspaceBySlug(tenant_id: string, slug: string): Promise<Workspace | null> {
    return this.workspaces.getWorkspaceBySlug(tenant_id, slug);
  }
  listWorkspaces(tenant_id: string): Promise<Workspace[]> {
    return this.workspaces.listWorkspaces(tenant_id);
  }
  softDeleteWorkspace(id: string, opts: { force?: boolean } = {}): Promise<void> {
    return this.workspaces.softDeleteWorkspace(id, opts);
  }
  addRepoToWorkspace(repo_id: string, workspace_id: string): Promise<void> {
    return this.workspaces.addRepoToWorkspace(repo_id, workspace_id);
  }
  removeRepoFromWorkspace(repo_id: string): Promise<void> {
    return this.workspaces.removeRepoFromWorkspace(repo_id);
  }
  getRepoWorkspaceId(repo_id: string): Promise<string | null> {
    return this.workspaces.getRepoWorkspaceId(repo_id);
  }
  listReposInWorkspace(tenant_id: string, workspace_id: string): Promise<Repo[]> {
    return this.workspaces.listReposInWorkspace(tenant_id, workspace_id);
  }

  // -- platform_docs (Wave 2c) ----------------------------------------------

  upsertPlatformDoc(input: {
    id?: string;
    tenant_id: string;
    workspace_id: string;
    doc_type: string;
    title: string;
    content_md: string;
    source?: Record<string, unknown>;
    generated_by?: PlatformDocFlavor;
    generated_from_run_id?: string | null;
    model?: string | null;
  }): Promise<PlatformDoc> {
    return this.docs.upsertPlatformDoc(input);
  }
  getPlatformDoc(workspace_id: string, doc_type: string): Promise<PlatformDoc | null> {
    return this.docs.getPlatformDoc(workspace_id, doc_type);
  }
  listPlatformDocs(workspace_id: string): Promise<PlatformDoc[]> {
    return this.docs.listPlatformDocs(workspace_id);
  }
  listDocVersions(doc_id: string): Promise<PlatformDocVersion[]> {
    return this.docs.listDocVersions(doc_id);
  }
  listDocVersionsByType(workspace_id: string, doc_type: string): Promise<PlatformDocVersion[]> {
    return this.docs.listDocVersionsByType(workspace_id, doc_type);
  }
  getDocVersion(doc_id: string, version: number): Promise<PlatformDocVersion | null> {
    return this.docs.getDocVersion(doc_id, version);
  }
}

export { DEFAULT_TENANT_ID };
