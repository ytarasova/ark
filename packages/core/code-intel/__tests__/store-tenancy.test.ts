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

beforeAll(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  store = new CodeIntelStore(db);
  await store.migrate();

  tenantA = (await store.createTenant({ name: "Tenant A", slug: "tenant-a" })).id;
  tenantB = (await store.createTenant({ name: "Tenant B", slug: "tenant-b" })).id;

  repoA = (await store.createRepo({ tenant_id: tenantA, repo_url: "file:///a", name: "a" })).id;
  repoB = (await store.createRepo({ tenant_id: tenantB, repo_url: "file:///b", name: "b" })).id;

  runA = (await store.beginIndexingRun({ tenant_id: tenantA, repo_id: repoA, branch: "main" })).id;
  runB = (await store.beginIndexingRun({ tenant_id: tenantB, repo_id: repoB, branch: "main" })).id;

  fileA = (
    await store.insertFile({ tenant_id: tenantA, repo_id: repoA, path: "a.ts", sha: "1", indexing_run_id: runA })
  ).id;
  fileB = (
    await store.insertFile({ tenant_id: tenantB, repo_id: repoB, path: "b.ts", sha: "2", indexing_run_id: runB })
  ).id;
});

afterAll(async () => {
  await db.close();
});

describe("CodeIntelStore tenant isolation", async () => {
  it("listRepos only returns the caller's tenant's repos", async () => {
    expect((await store.listRepos(tenantA)).map((r) => r.id)).toEqual([repoA]);
    expect((await store.listRepos(tenantB)).map((r) => r.id)).toEqual([repoB]);
  });

  it("getRepo refuses cross-tenant access", async () => {
    expect(await store.getRepo(tenantA, repoB)).toBeNull();
    expect(await store.getRepo(tenantB, repoA)).toBeNull();
  });

  it("listFiles is tenant-scoped", async () => {
    const aFiles = await store.listFiles(tenantA, repoA);
    expect(aFiles.length).toBe(1);
    expect(aFiles[0].id).toBe(fileA);
    expect((await store.listFiles(tenantA, repoB)).length).toBe(0);
    expect((await store.listFiles(tenantB, repoA)).length).toBe(0);
  });

  it("getFile is tenant-scoped", async () => {
    expect(await store.getFile(tenantA, fileB)).toBeNull();
    expect(await store.getFile(tenantB, fileA)).toBeNull();
  });

  it("findRepoByUrl is tenant-scoped", async () => {
    expect(await store.findRepoByUrl(tenantA, "file:///b")).toBeNull();
    expect(await store.findRepoByUrl(tenantB, "file:///a")).toBeNull();
  });

  it("symbols + chunks + edges respect tenant scope", async () => {
    const symA = (
      await store.insertSymbol({
        tenant_id: tenantA,
        file_id: fileA,
        kind: "function",
        name: "doStuff",
        indexing_run_id: runA,
      })
    ).id;
    await store.insertSymbol({
      tenant_id: tenantB,
      file_id: fileB,
      kind: "function",
      name: "doStuff",
      indexing_run_id: runB,
    });
    expect((await store.listSymbolsByFile(tenantA, fileA)).length).toBe(1);
    expect((await store.listSymbolsByFile(tenantA, fileB)).length).toBe(0);
    expect((await store.findSymbolByName(tenantA, "doStuff")).length).toBe(1);
    expect((await store.findSymbolByName(tenantB, "doStuff")).length).toBe(1);

    await store.insertChunk({
      tenant_id: tenantA,
      file_id: fileA,
      content: "alpha bravo",
      indexing_run_id: runA,
      path_hint: "a.ts",
      symbol_name: "doStuff",
    });
    await store.insertChunk({
      tenant_id: tenantB,
      file_id: fileB,
      content: "alpha bravo",
      indexing_run_id: runB,
      path_hint: "b.ts",
      symbol_name: "doStuff",
    });
    expect((await store.listChunksByFile(tenantA, fileA)).length).toBe(1);
    expect((await store.listChunksByFile(tenantA, fileB)).length).toBe(0);
    expect((await store.searchChunks(tenantA, "alpha")).length).toBe(1);
    expect((await store.searchChunks(tenantB, "alpha")).length).toBe(1);

    await store.insertEdge({
      tenant_id: tenantA,
      source_kind: "symbol",
      source_id: symA,
      target_kind: "file",
      target_id: fileA,
      relation: "defines",
      indexing_run_id: runA,
    });
    expect((await store.listEdgesFrom(tenantA, "symbol", symA)).length).toBe(1);
    expect((await store.listEdgesFrom(tenantB, "symbol", symA)).length).toBe(0);
  });

  it("dependencies + people + contributions respect tenant scope", async () => {
    await store.insertDependency({
      tenant_id: tenantA,
      repo_id: repoA,
      manifest_kind: "npm",
      name: "lodash",
      indexing_run_id: runA,
    });
    expect((await store.listDependencies(tenantA, repoA)).length).toBe(1);
    expect((await store.listDependencies(tenantB, repoA)).length).toBe(0);

    const personA = (await store.upsertPerson({ tenant_id: tenantA, primary_email: "x@y.z" })).id;
    expect((await store.listPeople(tenantA)).length).toBe(1);
    expect((await store.listPeople(tenantB)).length).toBe(0);

    await store.insertContribution({
      tenant_id: tenantA,
      person_id: personA,
      repo_id: repoA,
      commit_count: 1,
      indexing_run_id: runA,
    });
    expect((await store.listContributionsForRepo(tenantA, repoA)).length).toBe(1);
    expect((await store.listContributionsForRepo(tenantB, repoA)).length).toBe(0);
  });

  it("listIndexingRuns scoped per tenant", async () => {
    expect((await store.listIndexingRuns(tenantA)).length).toBe(1);
    expect((await store.listIndexingRuns(tenantB)).length).toBe(1);
    expect((await store.listIndexingRuns(tenantA, repoB)).length).toBe(0);
  });

  it("external_refs scoped per tenant", async () => {
    const symA = (await store.findSymbolByName(tenantA, "doStuff"))[0].id;
    await store.insertExternalRef({
      tenant_id: tenantA,
      symbol_id: symA,
      external_fqn: "ext.ref",
      indexing_run_id: runA,
    });
    expect((await store.listExternalRefs(tenantA)).length).toBe(1);
    expect((await store.listExternalRefs(tenantB)).length).toBe(0);
  });
});
