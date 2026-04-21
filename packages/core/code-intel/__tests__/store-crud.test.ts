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

beforeAll(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  store = new CodeIntelStore(db);
  await store.migrate();
});

afterAll(async () => {
  await db.close();
});

describe("CodeIntelStore CRUD", async () => {
  it("tenants -- list seed + create + lookup", async () => {
    expect((await store.listTenants()).length).toBe(1);
    const t = await store.createTenant({ name: "Acme", slug: "acme" });
    expect((await store.getTenant(t.id))?.slug).toBe("acme");
    expect((await store.getTenantBySlug("default"))?.id).toBe(DEFAULT_TENANT_ID);
  });

  it("repos -- create + list + lookup by url", async () => {
    const r = await store.createRepo({
      tenant_id: DEFAULT_TENANT_ID,
      repo_url: "file:///tmp/repo-a",
      name: "repo-a",
      local_path: "/tmp/repo-a",
      primary_language: "typescript",
    });
    repoId = r.id;
    expect((await store.listRepos(DEFAULT_TENANT_ID)).length).toBe(1);
    expect((await store.findRepoByUrl(DEFAULT_TENANT_ID, "file:///tmp/repo-a"))?.id).toBe(repoId);
    expect((await store.getRepo(DEFAULT_TENANT_ID, repoId))?.name).toBe("repo-a");
  });

  it("indexing_runs -- begin + finalize", async () => {
    const run = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    runId = run.id;
    expect(run.status).toBe("running");
    await store.finalizeIndexingRun({ run_id: runId, status: "ok", extractor_counts: { files: 3 } });
    const fin = await store.getIndexingRun(runId);
    expect(fin?.status).toBe("ok");
    expect(fin?.extractor_counts).toEqual({ files: 3 });
    expect((await store.listIndexingRuns(DEFAULT_TENANT_ID, repoId)).length).toBe(1);
  });

  it("files -- insert + lookup by id and path", async () => {
    // Use a fresh run since the previous one was finalized; re-using a
    // finalized run would soft-delete on the next finalize.
    const run = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    runId = run.id;
    const f = await store.insertFile({
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
    expect((await store.getFile(DEFAULT_TENANT_ID, fileId))?.path).toBe("src/app.ts");
    expect((await store.findFileByPath(DEFAULT_TENANT_ID, repoId, "src/app.ts"))?.id).toBe(fileId);
    expect((await store.listFiles(DEFAULT_TENANT_ID, repoId)).length).toBe(1);
  });

  it("symbols -- insert + lookup by name + by file", async () => {
    const s = await store.insertSymbol({
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
    expect((await store.listSymbolsByFile(DEFAULT_TENANT_ID, fileId)).length).toBe(1);
    expect((await store.findSymbolByName(DEFAULT_TENANT_ID, "init")).length).toBe(1);
  });

  it("chunks -- insert + lookup + list by file", async () => {
    const c = await store.insertChunk({
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
    expect((await store.getChunk(DEFAULT_TENANT_ID, chunkId))?.attrs).toEqual({ extracted_by: "files" });
    expect((await store.listChunksByFile(DEFAULT_TENANT_ID, fileId)).length).toBe(1);
  });

  it("edges -- insert + outbound + inbound", async () => {
    await store.insertEdge({
      tenant_id: DEFAULT_TENANT_ID,
      source_kind: "symbol",
      source_id: symbolId,
      target_kind: "file",
      target_id: fileId,
      relation: "defines",
      evidence_chunk_id: chunkId,
      indexing_run_id: runId,
    });
    expect((await store.listEdgesFrom(DEFAULT_TENANT_ID, "symbol", symbolId)).length).toBe(1);
    expect((await store.listEdgesTo(DEFAULT_TENANT_ID, "file", fileId)).length).toBe(1);
  });

  it("external_refs -- insert and list", async () => {
    await store.insertExternalRef({
      tenant_id: DEFAULT_TENANT_ID,
      symbol_id: symbolId,
      external_repo_hint: "github.com/foo/bar",
      external_fqn: "bar.qux.zot",
      indexing_run_id: runId,
    });
    expect((await store.listExternalRefs(DEFAULT_TENANT_ID)).length).toBe(1);
    expect((await store.listExternalRefs(DEFAULT_TENANT_ID, true)).length).toBe(1);
  });

  it("embeddings -- insert + lookup by composite key", async () => {
    const vec = new Uint8Array([1, 2, 3, 4]);
    await store.insertEmbedding({
      tenant_id: DEFAULT_TENANT_ID,
      subject_kind: "chunk",
      subject_id: chunkId,
      model: "test-model",
      model_version: "v1",
      dim: 1,
      vector: vec,
      indexing_run_id: runId,
    });
    const got = await store.getEmbedding(DEFAULT_TENANT_ID, "chunk", chunkId, "test-model", "v1");
    expect(got?.dim).toBe(1);
  });

  it("dependencies -- insert + list per repo", async () => {
    await store.insertDependency({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      manifest_kind: "npm",
      name: "lodash",
      resolved_version: "4.17.21",
      indexing_run_id: runId,
    });
    expect((await store.listDependencies(DEFAULT_TENANT_ID, repoId)).length).toBe(1);
  });

  it("people -- upsert returns existing, second call dedupes", async () => {
    const p = await store.upsertPerson({
      tenant_id: DEFAULT_TENANT_ID,
      primary_email: "alice@example.com",
      name: "Alice",
    });
    personId = p.id;
    const again = await store.upsertPerson({
      tenant_id: DEFAULT_TENANT_ID,
      primary_email: "alice@example.com",
      name: "Alice",
    });
    expect(again.id).toBe(personId);
    expect((await store.listPeople(DEFAULT_TENANT_ID)).length).toBe(1);
  });

  it("contributions -- insert and list per file + per repo", async () => {
    await store.insertContribution({
      tenant_id: DEFAULT_TENANT_ID,
      person_id: personId,
      repo_id: repoId,
      file_id: fileId,
      commit_count: 7,
      loc_added: 100,
      loc_removed: 20,
      indexing_run_id: runId,
    });
    await store.insertContribution({
      tenant_id: DEFAULT_TENANT_ID,
      person_id: personId,
      repo_id: repoId,
      file_id: null,
      commit_count: 25,
      loc_added: 500,
      loc_removed: 200,
      indexing_run_id: runId,
    });
    expect((await store.listContributionsForFile(DEFAULT_TENANT_ID, fileId)).length).toBe(1);
    expect((await store.listContributionsForRepo(DEFAULT_TENANT_ID, repoId)).length).toBe(1);
  });

  it("file_hotspots -- insert and lookup", async () => {
    await store.insertHotspot({
      tenant_id: DEFAULT_TENANT_ID,
      file_id: fileId,
      change_count_30d: 4,
      change_count_90d: 10,
      authors_count: 2,
      lines_touched: 300,
      risk_score: 0.42,
      indexing_run_id: runId,
    });
    expect((await store.getHotspotForFile(DEFAULT_TENANT_ID, fileId))?.risk_score).toBeCloseTo(0.42);
  });
});
