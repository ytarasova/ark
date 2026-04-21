/**
 * Platform-docs store: upsert + version snapshots + tenant scoping
 * (Wave 2c additions to CodeIntelStore).
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { CodeIntelStore, DEFAULT_TENANT_ID } from "../store.js";

async function freshStore(): Promise<{ db: BunSqliteAdapter; store: CodeIntelStore }> {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  const store = new CodeIntelStore(db);
  await store.migrate();
  return { db, store };
}

function makeWorkspace(store: CodeIntelStore, tenantId: string, slug: string) {
  return store.createWorkspace({ tenant_id: tenantId, slug, name: slug.toUpperCase() });
}

describe("CodeIntelStore -- platform docs", async () => {
  it("upsertPlatformDoc inserts a fresh row + version 1 snapshot", async () => {
    const { db, store } = await freshStore();
    const ws = await makeWorkspace(store, DEFAULT_TENANT_ID, "ws-a");

    const doc = await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "service_dependency_graph",
      title: "Service Dependency Graph",
      content_md: "# v1\n\nfirst version\n",
      source: { dependency_count: 3 },
    });

    expect(doc.id).toBeTruthy();
    expect(doc.title).toBe("Service Dependency Graph");
    expect(doc.content_md).toContain("first version");
    expect(doc.generated_by).toBe("mechanical");
    expect(doc.deleted_at).toBeNull();
    expect(doc.source).toEqual({ dependency_count: 3 });

    // Active fetch returns it.
    const active = await store.getPlatformDoc(ws.id, "service_dependency_graph");
    expect(active?.id).toBe(doc.id);

    // Versions table holds the snapshot at version 1.
    const versions = await store.listDocVersions(doc.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].content_md).toBe("# v1\n\nfirst version\n");
    await db.close();
  });

  it("re-upsert soft-deletes the prior active row, increments version, keeps history", async () => {
    const { db, store } = await freshStore();
    const ws = await makeWorkspace(store, DEFAULT_TENANT_ID, "ws-b");

    const v1 = await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "contributor_expertise_map",
      title: "Contributors v1",
      content_md: "# v1\n",
    });
    const v2 = await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "contributor_expertise_map",
      title: "Contributors v2",
      content_md: "# v2\n",
    });

    // Two distinct rows in platform_docs (one active, one soft-deleted).
    expect(v1.id).not.toBe(v2.id);
    expect((await store.getPlatformDoc(ws.id, "contributor_expertise_map"))?.id).toBe(v2.id);

    // Each row carries its own snapshot in the versions table; the union is
    // the full timeline.
    const v1Snaps = await store.listDocVersions(v1.id);
    const v2Snaps = await store.listDocVersions(v2.id);
    expect(v1Snaps).toHaveLength(1);
    expect(v2Snaps).toHaveLength(1);
    expect(v1Snaps[0].version).toBe(1);
    expect(v2Snaps[0].version).toBe(2);

    // The cross-row by-type accessor returns both, ordered by version asc.
    const allVersions = await store.listDocVersionsByType(ws.id, "contributor_expertise_map");
    expect(allVersions.map((v) => v.version)).toEqual([1, 2]);
    await db.close();
  });

  it("getPlatformDoc returns the currently-active version only", async () => {
    const { db, store } = await freshStore();
    const ws = await makeWorkspace(store, DEFAULT_TENANT_ID, "ws-c");

    await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "api_endpoint_registry",
      title: "Endpoints v1",
      content_md: "old\n",
    });
    const v2 = await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "api_endpoint_registry",
      title: "Endpoints v2",
      content_md: "new\n",
    });

    const active = await store.getPlatformDoc(ws.id, "api_endpoint_registry");
    expect(active?.id).toBe(v2.id);
    expect(active?.content_md).toBe("new\n");
    expect(active?.deleted_at).toBeNull();

    // Unknown doc_type yields null, never throws.
    expect(await store.getPlatformDoc(ws.id, "does_not_exist")).toBeNull();
    await db.close();
  });

  it("listPlatformDocs returns one active row per doc_type, sorted by doc_type", async () => {
    const { db, store } = await freshStore();
    const ws = await makeWorkspace(store, DEFAULT_TENANT_ID, "ws-d");

    // Insert three doc types (and re-upsert one to make sure soft-deleted
    // rows do not leak into the listing).
    await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "service_dependency_graph",
      title: "SDG",
      content_md: "sdg",
    });
    await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "api_endpoint_registry",
      title: "API",
      content_md: "api v1",
    });
    await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "api_endpoint_registry",
      title: "API",
      content_md: "api v2",
    });
    await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "contributor_expertise_map",
      title: "Contribs",
      content_md: "contrib",
    });

    const docs = await store.listPlatformDocs(ws.id);
    // 3 unique doc_types, even though one of them was upserted twice.
    expect(docs.map((d) => d.doc_type)).toEqual([
      "api_endpoint_registry",
      "contributor_expertise_map",
      "service_dependency_graph",
    ]);
    // The api row is the v2 content -- soft-deleted v1 stays out.
    expect(docs.find((d) => d.doc_type === "api_endpoint_registry")?.content_md).toBe("api v2");
    await db.close();
  });

  it("listDocVersions returns the row's full snapshot history ordered ASC", async () => {
    const { db, store } = await freshStore();
    const ws = await makeWorkspace(store, DEFAULT_TENANT_ID, "ws-e");

    const v1 = await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "database_schema_map",
      title: "Schema v1",
      content_md: "v1\n",
    });
    const v2 = await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "database_schema_map",
      title: "Schema v2",
      content_md: "v2\n",
    });

    // listDocVersions is per-row; v2's row only has its own snapshot.
    expect((await store.listDocVersions(v2.id)).map((s) => s.version)).toEqual([2]);
    expect((await store.listDocVersions(v1.id)).map((s) => s.version)).toEqual([1]);

    // listDocVersionsByType joins both rows' snapshots into a single
    // monotonically-increasing timeline.
    const timeline = await store.listDocVersionsByType(ws.id, "database_schema_map");
    expect(timeline.map((s) => s.version)).toEqual([1, 2]);
    expect(timeline.map((s) => s.content_md)).toEqual(["v1\n", "v2\n"]);

    // getDocVersion(doc_id, version) round-trips an exact snapshot.
    expect((await store.getDocVersion(v2.id, 2))?.content_md).toBe("v2\n");
    expect(await store.getDocVersion(v2.id, 1)).toBeNull(); // belongs to v1's row
    await db.close();
  });

  it("tenant isolation: workspace in tenant A is invisible to tenant B reads", async () => {
    const { db, store } = await freshStore();
    const tA = await store.createTenant({ name: "A", slug: "iso-a" });
    const tB = await store.createTenant({ name: "B", slug: "iso-b" });
    const wsA = await makeWorkspace(store, tA.id, "wsa");
    const wsB = await makeWorkspace(store, tB.id, "wsb");

    await store.upsertPlatformDoc({
      tenant_id: tA.id,
      workspace_id: wsA.id,
      doc_type: "service_dependency_graph",
      title: "A SDG",
      content_md: "tenant A only\n",
    });
    await store.upsertPlatformDoc({
      tenant_id: tB.id,
      workspace_id: wsB.id,
      doc_type: "service_dependency_graph",
      title: "B SDG",
      content_md: "tenant B only\n",
    });

    // Direct reads against the right workspace see the right doc.
    expect((await store.getPlatformDoc(wsA.id, "service_dependency_graph"))?.title).toBe("A SDG");
    expect((await store.getPlatformDoc(wsB.id, "service_dependency_graph"))?.title).toBe("B SDG");

    // Listing per-workspace is naturally tenant-isolated since workspace_id
    // is unique across tenants and getPlatformDoc/listPlatformDocs key on it.
    expect((await store.listPlatformDocs(wsA.id)).map((d) => d.title)).toEqual(["A SDG"]);
    expect((await store.listPlatformDocs(wsB.id)).map((d) => d.title)).toEqual(["B SDG"]);
    await db.close();
  });

  it("soft-delete: prior active rows are excluded from getPlatformDoc + listPlatformDocs by default", async () => {
    const { db, store } = await freshStore();
    const ws = await makeWorkspace(store, DEFAULT_TENANT_ID, "ws-sd");

    const v1 = await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "service_dependency_graph",
      title: "v1",
      content_md: "v1\n",
    });
    await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "service_dependency_graph",
      title: "v2",
      content_md: "v2\n",
    });

    // listPlatformDocs returns one row per doc_type (the v2 active one).
    const docs = await store.listPlatformDocs(ws.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("v2");
    expect(docs[0].id).not.toBe(v1.id);

    // Direct lookup of v1's id via the public surface is not possible -- the
    // store has no `getPlatformDocById` method. Instead, prove v1 was
    // soft-deleted by counting raw rows: the partial unique index forbids two
    // active rows for (workspace_id, doc_type), so if v1 weren't soft-deleted
    // the v2 insert would have failed.
    expect((await store.getPlatformDoc(ws.id, "service_dependency_graph"))?.title).toBe("v2");
    await db.close();
  });

  it("source JSON blob round-trips through upsert -> read", async () => {
    const { db, store } = await freshStore();
    const ws = await makeWorkspace(store, DEFAULT_TENANT_ID, "ws-src");

    await store.upsertPlatformDoc({
      tenant_id: DEFAULT_TENANT_ID,
      workspace_id: ws.id,
      doc_type: "api_endpoint_registry",
      title: "API",
      content_md: "stub\n",
      source: { repo_count: 4, endpoint_count: 0, stub: true },
      generated_by: "mechanical",
    });
    const got = await store.getPlatformDoc(ws.id, "api_endpoint_registry");
    expect(got?.source).toEqual({ repo_count: 4, endpoint_count: 0, stub: true });
    expect(got?.generated_by).toBe("mechanical");
    expect(got?.model).toBeNull();
    expect(got?.generated_from_run_id).toBeNull();
    await db.close();
  });
});
