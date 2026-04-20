/**
 * Platform-docs generator + per-extractor tests (Wave 2c).
 *
 * The "generator" promised by commit c2c9a982 (`platform-docs/generator.ts`)
 * was not actually shipped -- only the four extractor modules and the store
 * upsert path landed. The tests here exercise the four shipped extractors
 * end-to-end against an in-memory CodeIntelStore, which is exactly what a
 * generator-driven run would persist via `upsertPlatformDoc`. The
 * cadence-/--only-filter tests are kept as `it.todo()` until the generator
 * file lands; see report.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { CodeIntelStore, DEFAULT_TENANT_ID } from "../store.js";
import { apiEndpointRegistryExtractor } from "../extractors/platform-docs/api-endpoint-registry.js";
import { contributorExpertiseMapExtractor } from "../extractors/platform-docs/contributor-expertise-map.js";
import { databaseSchemaMapExtractor } from "../extractors/platform-docs/database-schema-map.js";
import { serviceDependencyGraphExtractor } from "../extractors/platform-docs/service-dependency-graph.js";
import type { PlatformDocContext } from "../interfaces/platform-doc-extractor.js";

function freshStore() {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  const store = new CodeIntelStore(db);
  store.migrate();
  return { db, store };
}

function ctx(store: CodeIntelStore, tenant_id = DEFAULT_TENANT_ID): PlatformDocContext {
  return { tenant_id, store };
}

describe("platform-docs extractors -- generator-equivalent end-to-end", () => {
  it("registered extractors all carry doc_type + flavor + cadence + generate", () => {
    const all = [
      apiEndpointRegistryExtractor,
      contributorExpertiseMapExtractor,
      databaseSchemaMapExtractor,
      serviceDependencyGraphExtractor,
    ];
    for (const e of all) {
      expect(typeof e.doc_type).toBe("string");
      expect(e.doc_type.length).toBeGreaterThan(0);
      expect(["mechanical", "llm", "hybrid"]).toContain(e.flavor);
      expect(["on_reindex", "daily", "weekly", "on_demand", "off"]).toContain(e.cadence);
      expect(typeof e.generate).toBe("function");
    }
    // doc_types must be unique across the registry so the upsert path works.
    const types = all.map((e) => e.doc_type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("empty workspace -> every stub extractor returns graceful 'no data' content (no throws)", async () => {
    const { db, store } = freshStore();
    const ws = store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "empty", name: "Empty" });

    const results = await Promise.all([
      apiEndpointRegistryExtractor.generate(ctx(store), ws.id),
      contributorExpertiseMapExtractor.generate(ctx(store), ws.id),
      databaseSchemaMapExtractor.generate(ctx(store), ws.id),
      serviceDependencyGraphExtractor.generate(ctx(store), ws.id),
    ]);
    for (const r of results) {
      expect(r.content_md).toMatch(/No repos|no repos|attached/i);
      expect(r.title.length).toBeGreaterThan(0);
    }
    // Persist them via the store path to prove the round-trip works.
    for (const [i, e] of [
      apiEndpointRegistryExtractor,
      contributorExpertiseMapExtractor,
      databaseSchemaMapExtractor,
      serviceDependencyGraphExtractor,
    ].entries()) {
      store.upsertPlatformDoc({
        tenant_id: DEFAULT_TENANT_ID,
        workspace_id: ws.id,
        doc_type: e.doc_type,
        title: results[i].title,
        content_md: results[i].content_md,
        source: results[i].source ?? {},
      });
    }
    expect(store.listPlatformDocs(ws.id)).toHaveLength(4);
    db.close();
  });

  it("workspace with seeded dependencies -> service-dependency-graph emits Mermaid + table", async () => {
    const { db, store } = freshStore();
    const ws = store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "deps", name: "Deps" });
    const repo = store.createRepo({
      tenant_id: DEFAULT_TENANT_ID,
      repo_url: "file:///tmp/sdg-repo",
      name: "payments",
    });
    store.addRepoToWorkspace(repo.id, ws.id);
    const run = store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repo.id, branch: "main" });
    store.insertDependency({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repo.id,
      manifest_kind: "npm",
      name: "lodash",
      resolved_version: "4.17.21",
      indexing_run_id: run.id,
    });
    store.insertDependency({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repo.id,
      manifest_kind: "npm",
      name: "react",
      resolved_version: "19.0.0",
      indexing_run_id: run.id,
    });

    const out = await serviceDependencyGraphExtractor.generate(ctx(store), ws.id);
    expect(out.title).toBe("Service Dependency Graph");
    expect(out.content_md).toContain("```mermaid");
    expect(out.content_md).toContain("flowchart LR");
    expect(out.content_md).toContain("payments");
    expect(out.content_md).toContain("lodash");
    expect(out.content_md).toContain("react");
    // Provenance counts come along for free.
    expect((out.source as { repo_count: number }).repo_count).toBe(1);
    expect((out.source as { dependency_count: number }).dependency_count).toBe(2);
    db.close();
  });

  it("workspace with contributions + people -> contributor-expertise-map renders table", async () => {
    const { db, store } = freshStore();
    const ws = store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "contribs", name: "Contribs" });
    const repo = store.createRepo({
      tenant_id: DEFAULT_TENANT_ID,
      repo_url: "file:///tmp/contrib-repo",
      name: "auth-service",
    });
    store.addRepoToWorkspace(repo.id, ws.id);
    const run = store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repo.id, branch: "main" });

    const alice = store.upsertPerson({
      tenant_id: DEFAULT_TENANT_ID,
      primary_email: "alice@example.com",
      name: "Alice Author",
    });
    const bob = store.upsertPerson({
      tenant_id: DEFAULT_TENANT_ID,
      primary_email: "bob@example.com",
      name: "Bob Builder",
    });
    store.insertContribution({
      tenant_id: DEFAULT_TENANT_ID,
      person_id: alice.id,
      repo_id: repo.id,
      file_id: null,
      commit_count: 42,
      loc_added: 1500,
      loc_removed: 200,
      first_commit: "2025-01-01T00:00:00Z",
      last_commit: "2026-04-19T00:00:00Z",
      indexing_run_id: run.id,
    });
    store.insertContribution({
      tenant_id: DEFAULT_TENANT_ID,
      person_id: bob.id,
      repo_id: repo.id,
      file_id: null,
      commit_count: 12,
      loc_added: 300,
      loc_removed: 50,
      first_commit: "2025-06-01T00:00:00Z",
      last_commit: "2026-03-01T00:00:00Z",
      indexing_run_id: run.id,
    });

    const out = await contributorExpertiseMapExtractor.generate(ctx(store), ws.id);
    expect(out.title).toBe("Contributor Expertise Map");
    expect(out.content_md).toContain("auth-service");
    expect(out.content_md).toContain("Alice Author");
    expect(out.content_md).toContain("Bob Builder");
    expect(out.content_md).toContain("alice@example.com");
    expect(out.content_md).toContain("| commits |");
    // Top contributor (Alice, 42 commits) is in the table.
    expect(out.content_md).toMatch(/Alice Author.*alice@example\.com.*42/);
    expect((out.source as { contribution_row_count: number }).contribution_row_count).toBe(2);
    db.close();
  });

  it("workspace with attached repos but no DDL/migration files -> database-schema-map stub message", async () => {
    const { db, store } = freshStore();
    const ws = store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "noddl", name: "NoDDL" });
    const repo = store.createRepo({
      tenant_id: DEFAULT_TENANT_ID,
      repo_url: "file:///tmp/noddl-repo",
      name: "frontend",
    });
    store.addRepoToWorkspace(repo.id, ws.id);
    const run = store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repo.id, branch: "main" });
    // A non-DDL file -- the heuristic must not match it.
    store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repo.id,
      path: "src/index.tsx",
      sha: "deadbeef",
      indexing_run_id: run.id,
    });

    const out = await databaseSchemaMapExtractor.generate(ctx(store), ws.id);
    expect(out.title).toBe("Database Schema Map");
    expect(out.content_md).toContain("Wave 2c");
    expect((out.source as { hit_count: number }).hit_count).toBe(0);
    expect((out.source as { repo_count: number }).repo_count).toBe(1);

    // Now add a real migration file and re-run -- it should be picked up.
    store.insertFile({
      tenant_id: DEFAULT_TENANT_ID,
      repo_id: repo.id,
      path: "db/migrations/001_init.sql",
      sha: "f00",
      indexing_run_id: run.id,
    });
    const out2 = await databaseSchemaMapExtractor.generate(ctx(store), ws.id);
    expect(out2.content_md).toContain("db/migrations/001_init.sql");
    expect((out2.source as { hit_count: number }).hit_count).toBe(1);
    db.close();
  });

  it("api-endpoint-registry returns workspace summary even without an endpoints table", async () => {
    const { db, store } = freshStore();
    const ws = store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "api", name: "API" });
    const repo = store.createRepo({
      tenant_id: DEFAULT_TENANT_ID,
      repo_url: "file:///tmp/api-repo",
      name: "edge",
    });
    store.addRepoToWorkspace(repo.id, ws.id);

    const out = await apiEndpointRegistryExtractor.generate(ctx(store), ws.id);
    expect(out.title).toBe("API Endpoint Registry");
    // The stub names every workspace repo so the doc is useful even before
    // the endpoints extractor lands.
    expect(out.content_md).toContain("edge");
    expect(out.content_md).toContain("file:///tmp/api-repo");
    expect((out.source as { stub: boolean }).stub).toBe(true);
    expect((out.source as { repo_count: number }).repo_count).toBe(1);
    db.close();
  });

  // The following two cases need `platform-docs/generator.ts`, which the
  // commit message claimed shipped but did NOT land in c2c9a982. Track the
  // missing module via TODOs rather than mocking a generator interface that
  // the actual code may diverge from.
  it.todo("generator iterates registered extractors and calls upsert per doc_type (needs generator.ts)");
  it.todo("generator --cadence filter (only on_reindex extractors run; needs generator.ts)");
  it.todo("generator --only filter (run only one named extractor; needs generator.ts)");
});
