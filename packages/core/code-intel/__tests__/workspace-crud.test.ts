/**
 * Workspace CRUD + tenant isolation + slug uniqueness (Wave 2a).
 *
 * Each `it` block stands on its own (fresh in-memory DB per test) so the
 * assertion order doesn't matter. Migration 002 runs as part of `migrate()`,
 * which means every fresh DB is post-Wave-2a state and includes a default
 * workspace seeded for the default tenant.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { CodeIntelStore, DEFAULT_TENANT_ID } from "../store.js";

function freshStore(): { db: BunSqliteAdapter; store: CodeIntelStore } {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  const store = new CodeIntelStore(db);
  store.migrate();
  return { db, store };
}

describe("CodeIntelStore -- workspaces CRUD", () => {
  it("seeds a default workspace for the default tenant after migrate", () => {
    const { db, store } = freshStore();
    const list = store.listWorkspaces(DEFAULT_TENANT_ID);
    expect(list.length).toBe(1);
    expect(list[0].slug).toBe("default");
    expect(list[0].name).toBe("Default");
    expect(list[0].deleted_at).toBeNull();
    db.close();
  });

  it("createWorkspace returns the row and listWorkspaces sees it", () => {
    const { db, store } = freshStore();
    const w = store.createWorkspace({
      tenant_id: DEFAULT_TENANT_ID,
      slug: "platform",
      name: "Platform",
      description: "Cross-team platform repos",
    });
    expect(w.slug).toBe("platform");
    expect(w.id).toBeDefined();
    const all = store.listWorkspaces(DEFAULT_TENANT_ID);
    expect(all.map((x) => x.slug).sort()).toEqual(["default", "platform"]);
    db.close();
  });

  it("getWorkspace + getWorkspaceBySlug round-trip", () => {
    const { db, store } = freshStore();
    const w = store.createWorkspace({
      tenant_id: DEFAULT_TENANT_ID,
      slug: "payments",
      name: "Payments",
    });
    expect(store.getWorkspace(w.id)?.slug).toBe("payments");
    expect(store.getWorkspaceBySlug(DEFAULT_TENANT_ID, "payments")?.id).toBe(w.id);
    expect(store.getWorkspaceBySlug(DEFAULT_TENANT_ID, "nope")).toBeNull();
    db.close();
  });

  it("config + description round-trip JSON", () => {
    const { db, store } = freshStore();
    const w = store.createWorkspace({
      tenant_id: DEFAULT_TENANT_ID,
      slug: "with-config",
      name: "With Config",
      config: { default_branch_policy: "main-protected", retention_days: 30 },
    });
    const fetched = store.getWorkspace(w.id);
    expect(fetched?.config).toEqual({ default_branch_policy: "main-protected", retention_days: 30 });
    expect(fetched?.description).toBeNull();
    db.close();
  });

  it("UNIQUE(tenant_id, slug) -- duplicate slug per tenant is rejected", () => {
    const { db, store } = freshStore();
    store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "dup", name: "First" });
    expect(() => store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "dup", name: "Second" })).toThrow();
    db.close();
  });

  it("same slug across different tenants is allowed", () => {
    const { db, store } = freshStore();
    const tA = store.createTenant({ name: "A", slug: "a" });
    const tB = store.createTenant({ name: "B", slug: "b" });
    const wA = store.createWorkspace({ tenant_id: tA.id, slug: "shared", name: "Shared in A" });
    const wB = store.createWorkspace({ tenant_id: tB.id, slug: "shared", name: "Shared in B" });
    expect(wA.id).not.toBe(wB.id);
    expect(store.getWorkspaceBySlug(tA.id, "shared")?.name).toBe("Shared in A");
    expect(store.getWorkspaceBySlug(tB.id, "shared")?.name).toBe("Shared in B");
    db.close();
  });

  it("listWorkspaces is tenant-scoped", () => {
    const { db, store } = freshStore();
    const tA = store.createTenant({ name: "A", slug: "ten-a" });
    const tB = store.createTenant({ name: "B", slug: "ten-b" });
    store.createWorkspace({ tenant_id: tA.id, slug: "wA", name: "WA" });
    store.createWorkspace({ tenant_id: tB.id, slug: "wB1", name: "WB1" });
    store.createWorkspace({ tenant_id: tB.id, slug: "wB2", name: "WB2" });
    expect(store.listWorkspaces(tA.id).map((w) => w.slug)).toEqual(["wA"]);
    expect(store.listWorkspaces(tB.id).map((w) => w.slug)).toEqual(["wB1", "wB2"]);
    db.close();
  });

  it("addRepoToWorkspace + listReposInWorkspace + removeRepoFromWorkspace", () => {
    const { db, store } = freshStore();
    const w = store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "core", name: "Core" });
    const r1 = store.createRepo({ tenant_id: DEFAULT_TENANT_ID, repo_url: "file:///r1", name: "r1" });
    const r2 = store.createRepo({ tenant_id: DEFAULT_TENANT_ID, repo_url: "file:///r2", name: "r2" });
    store.addRepoToWorkspace(r1.id, w.id);
    store.addRepoToWorkspace(r2.id, w.id);
    expect(
      store
        .listReposInWorkspace(DEFAULT_TENANT_ID, w.id)
        .map((r) => r.name)
        .sort(),
    ).toEqual(["r1", "r2"]);
    expect(store.getRepoWorkspaceId(r1.id)).toBe(w.id);
    store.removeRepoFromWorkspace(r1.id);
    expect(store.getRepoWorkspaceId(r1.id)).toBeNull();
    expect(store.listReposInWorkspace(DEFAULT_TENANT_ID, w.id).map((r) => r.name)).toEqual(["r2"]);
    db.close();
  });

  it("addRepoToWorkspace rejects cross-tenant attachment", () => {
    const { db, store } = freshStore();
    const tA = store.createTenant({ name: "A", slug: "x-a" });
    const tB = store.createTenant({ name: "B", slug: "x-b" });
    const wA = store.createWorkspace({ tenant_id: tA.id, slug: "w", name: "W" });
    const repoB = store.createRepo({ tenant_id: tB.id, repo_url: "file:///b", name: "b" });
    expect(() => store.addRepoToWorkspace(repoB.id, wA.id)).toThrow(/different tenants/);
    db.close();
  });

  it("softDeleteWorkspace refuses if repos are still attached, allows force", () => {
    const { db, store } = freshStore();
    const w = store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "del", name: "Del" });
    const r = store.createRepo({ tenant_id: DEFAULT_TENANT_ID, repo_url: "file:///del", name: "delr" });
    store.addRepoToWorkspace(r.id, w.id);
    expect(() => store.softDeleteWorkspace(w.id)).toThrow(/attached repo/);
    expect(store.getWorkspaceBySlug(DEFAULT_TENANT_ID, "del")?.id).toBe(w.id);
    store.softDeleteWorkspace(w.id, { force: true });
    expect(store.getWorkspaceBySlug(DEFAULT_TENANT_ID, "del")).toBeNull();
    expect(store.getRepoWorkspaceId(r.id)).toBeNull();
    // Repo itself is not deleted, just detached.
    expect(store.getRepo(DEFAULT_TENANT_ID, r.id)?.name).toBe("delr");
    db.close();
  });

  it("softDeleteWorkspace works without force when no repos are attached", () => {
    const { db, store } = freshStore();
    const w = store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "empty", name: "Empty" });
    store.softDeleteWorkspace(w.id);
    expect(store.getWorkspace(w.id)).toBeNull();
    expect(store.getWorkspaceBySlug(DEFAULT_TENANT_ID, "empty")).toBeNull();
    db.close();
  });

  it("getWorkspace excludes soft-deleted rows", () => {
    const { db, store } = freshStore();
    const w = store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "sd", name: "SD" });
    store.softDeleteWorkspace(w.id);
    expect(store.getWorkspace(w.id)).toBeNull();
    expect(store.listWorkspaces(DEFAULT_TENANT_ID).map((x) => x.slug)).not.toContain("sd");
    db.close();
  });

  it("listReposInWorkspace is tenant-scoped (cannot leak across tenants)", () => {
    const { db, store } = freshStore();
    const tA = store.createTenant({ name: "A", slug: "scope-a" });
    const tB = store.createTenant({ name: "B", slug: "scope-b" });
    const wA = store.createWorkspace({ tenant_id: tA.id, slug: "scope-w", name: "WA" });
    const rA = store.createRepo({ tenant_id: tA.id, repo_url: "file:///scope-a", name: "rA" });
    store.addRepoToWorkspace(rA.id, wA.id);
    // Use the right tenant -> sees the repo.
    expect(store.listReposInWorkspace(tA.id, wA.id).map((r) => r.name)).toEqual(["rA"]);
    // Use the other tenant -> sees nothing.
    expect(store.listReposInWorkspace(tB.id, wA.id)).toEqual([]);
    db.close();
  });
});
