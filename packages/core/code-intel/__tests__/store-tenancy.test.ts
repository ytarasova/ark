/**
 * Tenant isolation -- proves tenant A cannot read tenant B's rows via any
 * Wave 1 list / get accessor.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { CodeIntelStore } from "../store.js";

let db: BunSqliteAdapter;
let store: CodeIntelStore;
let tenantA: string;
let tenantB: string;
let repoA: string;
let repoB: string;
let fileA: string;
let fileB: string;
let runA: string;
let runB: string;

beforeAll(() => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  store = new CodeIntelStore(db);
  store.migrate();

  tenantA = store.createTenant({ name: "Tenant A", slug: "tenant-a" }).id;
  tenantB = store.createTenant({ name: "Tenant B", slug: "tenant-b" }).id;

  repoA = store.createRepo({ tenant_id: tenantA, repo_url: "file:///a", name: "a" }).id;
  repoB = store.createRepo({ tenant_id: tenantB, repo_url: "file:///b", name: "b" }).id;

  runA = store.beginIndexingRun({ tenant_id: tenantA, repo_id: repoA, branch: "main" }).id;
  runB = store.beginIndexingRun({ tenant_id: tenantB, repo_id: repoB, branch: "main" }).id;

  fileA = store.insertFile({ tenant_id: tenantA, repo_id: repoA, path: "a.ts", sha: "1", indexing_run_id: runA }).id;
  fileB = store.insertFile({ tenant_id: tenantB, repo_id: repoB, path: "b.ts", sha: "2", indexing_run_id: runB }).id;
});

afterAll(() => db.close());

describe("CodeIntelStore tenant isolation", () => {
  it("listRepos only returns the caller's tenant's repos", () => {
    expect(store.listRepos(tenantA).map((r) => r.id)).toEqual([repoA]);
    expect(store.listRepos(tenantB).map((r) => r.id)).toEqual([repoB]);
  });

  it("getRepo refuses cross-tenant access", () => {
    expect(store.getRepo(tenantA, repoB)).toBeNull();
    expect(store.getRepo(tenantB, repoA)).toBeNull();
  });

  it("listFiles is tenant-scoped", () => {
    const aFiles = store.listFiles(tenantA, repoA);
    expect(aFiles.length).toBe(1);
    expect(aFiles[0].id).toBe(fileA);
    expect(store.listFiles(tenantA, repoB).length).toBe(0);
    expect(store.listFiles(tenantB, repoA).length).toBe(0);
  });

  it("getFile is tenant-scoped", () => {
    expect(store.getFile(tenantA, fileB)).toBeNull();
    expect(store.getFile(tenantB, fileA)).toBeNull();
  });

  it("findRepoByUrl is tenant-scoped", () => {
    expect(store.findRepoByUrl(tenantA, "file:///b")).toBeNull();
    expect(store.findRepoByUrl(tenantB, "file:///a")).toBeNull();
  });

  it("symbols + chunks + edges respect tenant scope", () => {
    const symA = store.insertSymbol({
      tenant_id: tenantA,
      file_id: fileA,
      kind: "function",
      name: "doStuff",
      indexing_run_id: runA,
    }).id;
    store.insertSymbol({
      tenant_id: tenantB,
      file_id: fileB,
      kind: "function",
      name: "doStuff",
      indexing_run_id: runB,
    });
    expect(store.listSymbolsByFile(tenantA, fileA).length).toBe(1);
    expect(store.listSymbolsByFile(tenantA, fileB).length).toBe(0);
    expect(store.findSymbolByName(tenantA, "doStuff").length).toBe(1);
    expect(store.findSymbolByName(tenantB, "doStuff").length).toBe(1);

    store.insertChunk({
      tenant_id: tenantA,
      file_id: fileA,
      content: "alpha bravo",
      indexing_run_id: runA,
      path_hint: "a.ts",
      symbol_name: "doStuff",
    });
    store.insertChunk({
      tenant_id: tenantB,
      file_id: fileB,
      content: "alpha bravo",
      indexing_run_id: runB,
      path_hint: "b.ts",
      symbol_name: "doStuff",
    });
    expect(store.listChunksByFile(tenantA, fileA).length).toBe(1);
    expect(store.listChunksByFile(tenantA, fileB).length).toBe(0);
    expect(store.searchChunks(tenantA, "alpha").length).toBe(1);
    expect(store.searchChunks(tenantB, "alpha").length).toBe(1);

    store.insertEdge({
      tenant_id: tenantA,
      source_kind: "symbol",
      source_id: symA,
      target_kind: "file",
      target_id: fileA,
      relation: "defines",
      indexing_run_id: runA,
    });
    expect(store.listEdgesFrom(tenantA, "symbol", symA).length).toBe(1);
    expect(store.listEdgesFrom(tenantB, "symbol", symA).length).toBe(0);
  });

  it("dependencies + people + contributions respect tenant scope", () => {
    store.insertDependency({
      tenant_id: tenantA,
      repo_id: repoA,
      manifest_kind: "npm",
      name: "lodash",
      indexing_run_id: runA,
    });
    expect(store.listDependencies(tenantA, repoA).length).toBe(1);
    expect(store.listDependencies(tenantB, repoA).length).toBe(0);

    const personA = store.upsertPerson({ tenant_id: tenantA, primary_email: "x@y.z" }).id;
    expect(store.listPeople(tenantA).length).toBe(1);
    expect(store.listPeople(tenantB).length).toBe(0);

    store.insertContribution({
      tenant_id: tenantA,
      person_id: personA,
      repo_id: repoA,
      commit_count: 1,
      indexing_run_id: runA,
    });
    expect(store.listContributionsForRepo(tenantA, repoA).length).toBe(1);
    expect(store.listContributionsForRepo(tenantB, repoA).length).toBe(0);
  });

  it("listIndexingRuns scoped per tenant", () => {
    expect(store.listIndexingRuns(tenantA).length).toBe(1);
    expect(store.listIndexingRuns(tenantB).length).toBe(1);
    expect(store.listIndexingRuns(tenantA, repoB).length).toBe(0);
  });

  it("external_refs scoped per tenant", () => {
    const symA = store.findSymbolByName(tenantA, "doStuff")[0].id;
    store.insertExternalRef({
      tenant_id: tenantA,
      symbol_id: symA,
      external_fqn: "ext.ref",
      indexing_run_id: runA,
    });
    expect(store.listExternalRefs(tenantA).length).toBe(1);
    expect(store.listExternalRefs(tenantB).length).toBe(0);
  });
});
