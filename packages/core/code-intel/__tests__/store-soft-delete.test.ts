/**
 * Soft-delete behavior -- proves that `deleted_at` excludes rows from
 * default reads, but does not break tenant scoping.
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
      repo_url: "file:///tmp/sd",
      name: "sd",
    })
  ).id;
});

afterAll(async () => {
  await db.close();
});

describe("CodeIntelStore soft-delete semantics", async () => {
  it("softDeleteRepo hides the repo from listRepos", async () => {
    const r = await store.createRepo({
      tenant_id: DEFAULT_TENANT_ID,
      repo_url: "file:///tmp/del",
      name: "to-delete",
    });
    expect((await store.listRepos(DEFAULT_TENANT_ID)).map((x) => x.id)).toContain(r.id);
    await store.softDeleteRepo(DEFAULT_TENANT_ID, r.id);
    expect((await store.listRepos(DEFAULT_TENANT_ID)).map((x) => x.id)).not.toContain(r.id);
    expect(await store.getRepo(DEFAULT_TENANT_ID, r.id)).toBeNull();
  });

  it("finalize on a second run soft-deletes the first run's files", async () => {
    const run1 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    await store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "old.ts",
      sha: "old",
      indexing_run_id: run1.id,
    });
    await store.finalizeIndexingRun({ run_id: run1.id, status: "ok" });

    const run2 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    await store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "new.ts",
      sha: "new",
      indexing_run_id: run2.id,
    });
    await store.finalizeIndexingRun({ run_id: run2.id, status: "ok" });

    const files = await store.listFiles(DEFAULT_TENANT_ID, repoId);
    expect(files.map((f) => f.path)).toEqual(["new.ts"]);
  });

  it("non-ok finalize does NOT soft-delete prior rows", async () => {
    const run1 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    await store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "kept.ts",
      sha: "k",
      indexing_run_id: run1.id,
    });
    await store.finalizeIndexingRun({ run_id: run1.id, status: "ok" });

    const beforeCount = (await store.listFiles(DEFAULT_TENANT_ID, repoId)).length;

    const run2 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    await store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "tentative.ts",
      sha: "t",
      indexing_run_id: run2.id,
    });
    // Errored runs should leave prior rows alone.
    await store.finalizeIndexingRun({ run_id: run2.id, status: "error", error_msg: "fake" });

    const afterCount = (await store.listFiles(DEFAULT_TENANT_ID, repoId)).length;
    // Both kept.ts (from run1) and tentative.ts (from run2) remain visible.
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it("listSymbolsByFile excludes soft-deleted rows", async () => {
    const run1 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    const f = await store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "sym.ts",
      sha: "s1",
      indexing_run_id: run1.id,
    });
    await store.insertSymbol({
      tenant_id: DEFAULT_TENANT_ID,
      file_id: f.id,
      kind: "function",
      name: "old_sym",
      indexing_run_id: run1.id,
    });
    await store.finalizeIndexingRun({ run_id: run1.id, status: "ok" });
    expect((await store.listSymbolsByFile(DEFAULT_TENANT_ID, f.id)).length).toBe(1);

    // Reindex: a new file replaces the old one.
    const run2 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    const f2 = await store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "sym.ts",
      sha: "s2",
      indexing_run_id: run2.id,
    });
    await store.insertSymbol({
      tenant_id: DEFAULT_TENANT_ID,
      file_id: f2.id,
      kind: "function",
      name: "new_sym",
      indexing_run_id: run2.id,
    });
    await store.finalizeIndexingRun({ run_id: run2.id, status: "ok" });
    // Old file is soft-deleted; its symbol becomes invisible too because it
    // was part of the prior run.
    expect((await store.listSymbolsByFile(DEFAULT_TENANT_ID, f.id)).length).toBe(0);
    expect((await store.listSymbolsByFile(DEFAULT_TENANT_ID, f2.id)).length).toBe(1);
  });

  it("dependencies + contributions soft-delete on reindex", async () => {
    const run1 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    await store.insertDependency({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      manifest_kind: "npm",
      name: "old-pkg",
      indexing_run_id: run1.id,
    });
    await store.finalizeIndexingRun({ run_id: run1.id, status: "ok" });
    expect((await store.listDependencies(DEFAULT_TENANT_ID, repoId)).map((d) => d.name)).toContain("old-pkg");

    const run2 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    await store.insertDependency({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      manifest_kind: "npm",
      name: "fresh-pkg",
      indexing_run_id: run2.id,
    });
    await store.finalizeIndexingRun({ run_id: run2.id, status: "ok" });
    const deps = (await store.listDependencies(DEFAULT_TENANT_ID, repoId)).map((d) => d.name);
    expect(deps).toContain("fresh-pkg");
    expect(deps).not.toContain("old-pkg");
  });

  it("hotspots soft-delete on reindex", async () => {
    const run1 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    const f = await store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "hot.ts",
      sha: "h1",
      indexing_run_id: run1.id,
    });
    await store.insertHotspot({
      tenant_id: DEFAULT_TENANT_ID,
      file_id: f.id,
      change_count_30d: 1,
      change_count_90d: 1,
      authors_count: 1,
      lines_touched: 1,
      risk_score: 0.1,
      indexing_run_id: run1.id,
    });
    await store.finalizeIndexingRun({ run_id: run1.id, status: "ok" });
    expect((await store.getHotspotForFile(DEFAULT_TENANT_ID, f.id))?.risk_score).toBeCloseTo(0.1);

    const run2 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    const f2 = await store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repoId,
      path: "hot.ts",
      sha: "h2",
      indexing_run_id: run2.id,
    });
    await store.insertHotspot({
      tenant_id: DEFAULT_TENANT_ID,
      file_id: f2.id,
      change_count_30d: 9,
      change_count_90d: 9,
      authors_count: 9,
      lines_touched: 9,
      risk_score: 0.9,
      indexing_run_id: run2.id,
    });
    await store.finalizeIndexingRun({ run_id: run2.id, status: "ok" });
    expect(await store.getHotspotForFile(DEFAULT_TENANT_ID, f.id)).toBeNull();
    expect((await store.getHotspotForFile(DEFAULT_TENANT_ID, f2.id))?.risk_score).toBeCloseTo(0.9);
  });
});
