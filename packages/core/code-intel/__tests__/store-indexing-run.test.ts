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

beforeAll(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  store = new CodeIntelStore(db);
  await store.migrate();
  repoId = (
    await store.createRepo({
      tenant_id: DEFAULT_TENANT_ID,
      repo_url: "file:///tmp/lifecycle",
      name: "lifecycle",
    })
  ).id;
});

afterAll(async () => {
  await db.close();
});

describe("indexing_runs lifecycle", async () => {
  it("begin creates a row in 'running' status", async () => {
    const r = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    expect(r.status).toBe("running");
    expect(r.finished_at).toBeNull();
    const fetched = await store.getIndexingRun(r.id);
    expect(fetched?.status).toBe("running");
  });

  it("finalize ok updates status + extractor_counts + finished_at", async () => {
    const r = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    await store.finalizeIndexingRun({
      run_id: r.id,
      status: "ok",
      extractor_counts: { files: 5, symbols: 12 },
    });
    const fin = await store.getIndexingRun(r.id);
    expect(fin?.status).toBe("ok");
    expect(fin?.finished_at).not.toBeNull();
    expect(fin?.extractor_counts).toEqual({ files: 5, symbols: 12 });
    expect(fin?.error_msg).toBeNull();
  });

  it("finalize error records the message", async () => {
    const r = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    await store.finalizeIndexingRun({ run_id: r.id, status: "error", error_msg: "boom" });
    const fin = await store.getIndexingRun(r.id);
    expect(fin?.status).toBe("error");
    expect(fin?.error_msg).toBe("boom");
  });

  it("listIndexingRuns returns most-recent first", async () => {
    const before = (await store.listIndexingRuns(DEFAULT_TENANT_ID, repoId)).length;
    // Nudge the clock forward so `started_at` is strictly greater than any
    // previously-inserted run in this test file. `listIndexingRuns` orders by
    // `started_at DESC, id DESC`; without the gap, two runs can land in the
    // same millisecond and the UUID tiebreaker becomes order-sensitive.
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    await store.finalizeIndexingRun({ run_id: fresh.id, status: "ok" });
    const after = await store.listIndexingRuns(DEFAULT_TENANT_ID, repoId);
    expect(after.length).toBe(before + 1);
    expect(after[0].id).toBe(fresh.id);
  });

  it("finalize ok soft-deletes prior runs' rows but keeps the new run's rows visible", async () => {
    const r1 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    const f1 = await store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "lifecycle/a.ts",
      sha: "x1",
      indexing_run_id: r1.id,
    });
    await store.finalizeIndexingRun({ run_id: r1.id, status: "ok" });
    expect(await store.getFile(DEFAULT_TENANT_ID, f1.id)).not.toBeNull();

    const r2 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    const f2 = await store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "lifecycle/a.ts",
      sha: "x2",
      indexing_run_id: r2.id,
    });
    // Prior file still visible during r2 (not yet finalized).
    expect(await store.getFile(DEFAULT_TENANT_ID, f1.id)).not.toBeNull();
    await store.finalizeIndexingRun({ run_id: r2.id, status: "ok" });
    // Prior file disappears, new file remains.
    expect(await store.getFile(DEFAULT_TENANT_ID, f1.id)).toBeNull();
    expect(await store.getFile(DEFAULT_TENANT_ID, f2.id)).not.toBeNull();
  });
});
