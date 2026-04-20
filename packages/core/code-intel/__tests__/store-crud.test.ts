/**
 * One roundtrip per Wave 1 table -- proves the store can insert, fetch,
 * and round-trip JSON columns + UUIDs through every CRUD path.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { CodeIntelStore, DEFAULT_TENANT_ID } from "../store.js";

let db: BunSqliteAdapter;
let store: CodeIntelStore;
let repoId: string;
let runId: string;
let fileId: string;
let symbolId: string;
let chunkId: string;
let personId: string;

beforeAll(() => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  store = new CodeIntelStore(db);
  store.migrate();
});

afterAll(() => {
  db.close();
});

describe("CodeIntelStore CRUD", () => {
  it("tenants -- list seed + create + lookup", () => {
    expect(store.listTenants().length).toBe(1);
    const t = store.createTenant({ name: "Acme", slug: "acme" });
    expect(store.getTenant(t.id)?.slug).toBe("acme");
    expect(store.getTenantBySlug("default")?.id).toBe(DEFAULT_TENANT_ID);
  });

  it("repos -- create + list + lookup by url", () => {
    const r = store.createRepo({
      tenant_id: DEFAULT_TENANT_ID,
      repo_url: "file:///tmp/repo-a",
      name: "repo-a",
      local_path: "/tmp/repo-a",
      primary_language: "typescript",
    });
    repoId = r.id;
    expect(store.listRepos(DEFAULT_TENANT_ID).length).toBe(1);
    expect(store.findRepoByUrl(DEFAULT_TENANT_ID, "file:///tmp/repo-a")?.id).toBe(repoId);
    expect(store.getRepo(DEFAULT_TENANT_ID, repoId)?.name).toBe("repo-a");
  });

  it("indexing_runs -- begin + finalize", () => {
    const run = store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    runId = run.id;
    expect(run.status).toBe("running");
    store.finalizeIndexingRun({ run_id: runId, status: "ok", extractor_counts: { files: 3 } });
    const fin = store.getIndexingRun(runId);
    expect(fin?.status).toBe("ok");
    expect(fin?.extractor_counts).toEqual({ files: 3 });
    expect(store.listIndexingRuns(DEFAULT_TENANT_ID, repoId).length).toBe(1);
  });

  it("files -- insert + lookup by id and path", () => {
    // Use a fresh run since the previous one was finalized; re-using a
    // finalized run would soft-delete on the next finalize.
    const run = store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    runId = run.id;
    const f = store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "src/app.ts",
      sha: "shaA",
      mtime: new Date().toISOString(),
      language: "typescript",
      size_bytes: 1234,
      indexing_run_id: runId,
    });
    fileId = f.id;
    expect(store.getFile(DEFAULT_TENANT_ID, fileId)?.path).toBe("src/app.ts");
    expect(store.findFileByPath(DEFAULT_TENANT_ID, repoId, "src/app.ts")?.id).toBe(fileId);
    expect(store.listFiles(DEFAULT_TENANT_ID, repoId).length).toBe(1);
  });

  it("symbols -- insert + lookup by name + by file", () => {
    const s = store.insertSymbol({
      tenant_id: DEFAULT_TENANT_ID,
      file_id: fileId,
      kind: "function",
      name: "init",
      fqn: "src/app.init",
      line_start: 5,
      line_end: 10,
      indexing_run_id: runId,
    });
    symbolId = s.id;
    expect(store.listSymbolsByFile(DEFAULT_TENANT_ID, fileId).length).toBe(1);
    expect(store.findSymbolByName(DEFAULT_TENANT_ID, "init").length).toBe(1);
  });

  it("chunks -- insert + lookup + list by file", () => {
    const c = store.insertChunk({
      tenant_id: DEFAULT_TENANT_ID,
      file_id: fileId,
      symbol_id: symbolId,
      content: "function init() { return 1; }",
      chunk_kind: "code",
      attrs: { extracted_by: "files" },
      indexing_run_id: runId,
      path_hint: "src/app.ts",
      symbol_name: "init",
    });
    chunkId = c.id;
    expect(store.getChunk(DEFAULT_TENANT_ID, chunkId)?.attrs).toEqual({ extracted_by: "files" });
    expect(store.listChunksByFile(DEFAULT_TENANT_ID, fileId).length).toBe(1);
  });

  it("edges -- insert + outbound + inbound", () => {
    store.insertEdge({
      tenant_id: DEFAULT_TENANT_ID,
      source_kind: "symbol",
      source_id: symbolId,
      target_kind: "file",
      target_id: fileId,
      relation: "defines",
      evidence_chunk_id: chunkId,
      indexing_run_id: runId,
    });
    expect(store.listEdgesFrom(DEFAULT_TENANT_ID, "symbol", symbolId).length).toBe(1);
    expect(store.listEdgesTo(DEFAULT_TENANT_ID, "file", fileId).length).toBe(1);
  });

  it("external_refs -- insert and list", () => {
    store.insertExternalRef({
      tenant_id: DEFAULT_TENANT_ID,
      symbol_id: symbolId,
      external_repo_hint: "github.com/foo/bar",
      external_fqn: "bar.qux.zot",
      indexing_run_id: runId,
    });
    expect(store.listExternalRefs(DEFAULT_TENANT_ID).length).toBe(1);
    expect(store.listExternalRefs(DEFAULT_TENANT_ID, true).length).toBe(1);
  });

  it("embeddings -- insert + lookup by composite key", () => {
    const vec = new Uint8Array([1, 2, 3, 4]);
    store.insertEmbedding({
      tenant_id: DEFAULT_TENANT_ID,
      subject_kind: "chunk",
      subject_id: chunkId,
      model: "test-model",
      model_version: "v1",
      dim: 1,
      vector: vec,
      indexing_run_id: runId,
    });
    const got = store.getEmbedding(DEFAULT_TENANT_ID, "chunk", chunkId, "test-model", "v1");
    expect(got?.dim).toBe(1);
  });

  it("dependencies -- insert + list per repo", () => {
    store.insertDependency({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      manifest_kind: "npm",
      name: "lodash",
      resolved_version: "4.17.21",
      indexing_run_id: runId,
    });
    expect(store.listDependencies(DEFAULT_TENANT_ID, repoId).length).toBe(1);
  });

  it("people -- upsert returns existing, second call dedupes", () => {
    const p = store.upsertPerson({
      tenant_id: DEFAULT_TENANT_ID,
      primary_email: "alice@example.com",
      name: "Alice",
    });
    personId = p.id;
    const again = store.upsertPerson({
      tenant_id: DEFAULT_TENANT_ID,
      primary_email: "alice@example.com",
      name: "Alice",
    });
    expect(again.id).toBe(personId);
    expect(store.listPeople(DEFAULT_TENANT_ID).length).toBe(1);
  });

  it("contributions -- insert and list per file + per repo", () => {
    store.insertContribution({
      tenant_id: DEFAULT_TENANT_ID,
      person_id: personId,
      repo_id: repoId,
      file_id: fileId,
      commit_count: 7,
      loc_added: 100,
      loc_removed: 20,
      indexing_run_id: runId,
    });
    store.insertContribution({
      tenant_id: DEFAULT_TENANT_ID,
      person_id: personId,
      repo_id: repoId,
      file_id: null,
      commit_count: 25,
      loc_added: 500,
      loc_removed: 200,
      indexing_run_id: runId,
    });
    expect(store.listContributionsForFile(DEFAULT_TENANT_ID, fileId).length).toBe(1);
    expect(store.listContributionsForRepo(DEFAULT_TENANT_ID, repoId).length).toBe(1);
  });

  it("file_hotspots -- insert and lookup", () => {
    store.insertHotspot({
      tenant_id: DEFAULT_TENANT_ID,
      file_id: fileId,
      change_count_30d: 4,
      change_count_90d: 10,
      authors_count: 2,
      lines_touched: 300,
      risk_score: 0.42,
      indexing_run_id: runId,
    });
    expect(store.getHotspotForFile(DEFAULT_TENANT_ID, fileId)?.risk_score).toBeCloseTo(0.42);
  });
});
