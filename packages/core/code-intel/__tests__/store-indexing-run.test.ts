/**
 * indexing_runs lifecycle -- proves the begin/populate/finalize cycle and
 * the soft-delete-of-prior-active-rows behavior promised by the doc.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { CodeIntelStore, DEFAULT_TENANT_ID } from "../store.js";

let db: BunSqliteAdapter;
let store: CodeIntelStore;
let repoId: string;

beforeAll(() => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  store = new CodeIntelStore(db);
  store.migrate();
  repoId = store.createRepo({
    tenant_id: DEFAULT_TENANT_ID,
    repo_url: "file:///tmp/lifecycle",
    name: "lifecycle",
  }).id;
});

afterAll(() => db.close());

describe("indexing_runs lifecycle", () => {
  it("begin creates a row in 'running' status", () => {
    const r = store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    expect(r.status).toBe("running");
    expect(r.finished_at).toBeNull();
    const fetched = store.getIndexingRun(r.id);
    expect(fetched?.status).toBe("running");
  });

  it("finalize ok updates status + extractor_counts + finished_at", () => {
    const r = store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    store.finalizeIndexingRun({
      run_id: r.id,
      status: "ok",
      extractor_counts: { files: 5, symbols: 12 },
    });
    const fin = store.getIndexingRun(r.id);
    expect(fin?.status).toBe("ok");
    expect(fin?.finished_at).not.toBeNull();
    expect(fin?.extractor_counts).toEqual({ files: 5, symbols: 12 });
    expect(fin?.error_msg).toBeNull();
  });

  it("finalize error records the message", () => {
    const r = store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    store.finalizeIndexingRun({ run_id: r.id, status: "error", error_msg: "boom" });
    const fin = store.getIndexingRun(r.id);
    expect(fin?.status).toBe("error");
    expect(fin?.error_msg).toBe("boom");
  });

  it("listIndexingRuns returns most-recent first", () => {
    const before = store.listIndexingRuns(DEFAULT_TENANT_ID, repoId).length;
    const fresh = store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    store.finalizeIndexingRun({ run_id: fresh.id, status: "ok" });
    const after = store.listIndexingRuns(DEFAULT_TENANT_ID, repoId);
    expect(after.length).toBe(before + 1);
    expect(after[0].id).toBe(fresh.id);
  });

  it("finalize ok soft-deletes prior runs' rows but keeps the new run's rows visible", () => {
    const r1 = store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    const f1 = store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "lifecycle/a.ts",
      sha: "x1",
      indexing_run_id: r1.id,
    });
    store.finalizeIndexingRun({ run_id: r1.id, status: "ok" });
    expect(store.getFile(DEFAULT_TENANT_ID, f1.id)).not.toBeNull();

    const r2 = store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    const f2 = store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "lifecycle/a.ts",
      sha: "x2",
      indexing_run_id: r2.id,
    });
    // Prior file still visible during r2 (not yet finalized).
    expect(store.getFile(DEFAULT_TENANT_ID, f1.id)).not.toBeNull();
    store.finalizeIndexingRun({ run_id: r2.id, status: "ok" });
    // Prior file disappears, new file remains.
    expect(store.getFile(DEFAULT_TENANT_ID, f1.id)).toBeNull();
    expect(store.getFile(DEFAULT_TENANT_ID, f2.id)).not.toBeNull();
  });
});
