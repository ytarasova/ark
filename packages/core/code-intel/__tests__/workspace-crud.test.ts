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

async function freshStore(): Promise<{ db: BunSqliteAdapter; store: CodeIntelStore }> {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  const store = new CodeIntelStore(db);
  await store.migrate();
  return { db, store };
}

describe("CodeIntelStore -- workspaces CRUD", async () => {
  it("seeds a default workspace for the default tenant after migrate", async () => {
    const { db, store } = await freshStore();
    const list = await store.listWorkspaces(DEFAULT_TENANT_ID);
    expect(list.length).toBe(1);
    expect(list[0].slug).toBe("default");
    expect(list[0].name).toBe("Default");
    expect(list[0].deleted_at).toBeNull();
    await db.close();
  });

  it("createWorkspace returns the row and listWorkspaces sees it", async () => {
    const { db, store } = await freshStore();
    const w = await store.createWorkspace({
      tenant_id: DEFAULT_TENANT_ID,
      slug: "platform",
      name: "Platform",
      description: "Cross-team platform repos",
    });
    expect(w.slug).toBe("platform");
    expect(w.id).toBeDefined();
    const all = await store.listWorkspaces(DEFAULT_TENANT_ID);
    expect(all.map((x) => x.slug).sort()).toEqual(["default", "platform"]);
    await db.close();
  });

  it("getWorkspace + getWorkspaceBySlug round-trip", async () => {
    const { db, store } = await freshStore();
    const w = await store.createWorkspace({
      tenant_id: DEFAULT_TENANT_ID,
      slug: "payments",
      name: "Payments",
    });
    expect((await store.getWorkspace(w.id))?.slug).toBe("payments");
    expect((await store.getWorkspaceBySlug(DEFAULT_TENANT_ID, "payments"))?.id).toBe(w.id);
    expect(await store.getWorkspaceBySlug(DEFAULT_TENANT_ID, "nope")).toBeNull();
    await db.close();
  });

  it("config + description round-trip JSON", async () => {
    const { db, store } = await freshStore();
    const w = await store.createWorkspace({
      tenant_id: DEFAULT_TENANT_ID,
      slug: "with-config",
      name: "With Config",
      config: { default_branch_policy: "main-protected", retention_days: 30 },
    });
    const fetched = await store.getWorkspace(w.id);
    expect(fetched?.config).toEqual({ default_branch_policy: "main-protected", retention_days: 30 });
    expect(fetched?.description).toBeNull();
    await db.close();
  });

  it("UNIQUE(tenant_id, slug) -- duplicate slug per tenant is rejected", async () => {
    const { db, store } = await freshStore();
    await store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "dup", name: "First" });
    (
      await expect(store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "dup", name: "Second" }))
    ).rejects.toThrow();
    await db.close();
  });

  it("same slug across different tenants is allowed", async () => {
    const { db, store } = await freshStore();
    const tA = await store.createTenant({ name: "A", slug: "a" });
    const tB = await store.createTenant({ name: "B", slug: "b" });
    const wA = await store.createWorkspace({ tenant_id: tA.id, slug: "shared", name: "Shared in A" });
    const wB = await store.createWorkspace({ tenant_id: tB.id, slug: "shared", name: "Shared in B" });
    expect(wA.id).not.toBe(wB.id);
    expect((await store.getWorkspaceBySlug(tA.id, "shared"))?.name).toBe("Shared in A");
    expect((await store.getWorkspaceBySlug(tB.id, "shared"))?.name).toBe("Shared in B");
    await db.close();
  });

  it("listWorkspaces is tenant-scoped", async () => {
    const { db, store } = await freshStore();
    const tA = await store.createTenant({ name: "A", slug: "ten-a" });
    const tB = await store.createTenant({ name: "B", slug: "ten-b" });
    await store.createWorkspace({ tenant_id: tA.id, slug: "wA", name: "WA" });
    await store.createWorkspace({ tenant_id: tB.id, slug: "wB1", name: "WB1" });
    await store.createWorkspace({ tenant_id: tB.id, slug: "wB2", name: "WB2" });
    expect((await store.listWorkspaces(tA.id)).map((w) => w.slug)).toEqual(["wA"]);
    expect((await store.listWorkspaces(tB.id)).map((w) => w.slug)).toEqual(["wB1", "wB2"]);
    await db.close();
  });

  it("addRepoToWorkspace + listReposInWorkspace + removeRepoFromWorkspace", async () => {
    const { db, store } = await freshStore();
    const w = await store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "core", name: "Core" });
    const r1 = await store.createRepo({ tenant_id: DEFAULT_TENANT_ID, repo_url: "file:///r1", name: "r1" });
    const r2 = await store.createRepo({ tenant_id: DEFAULT_TENANT_ID, repo_url: "file:///r2", name: "r2" });
    await store.addRepoToWorkspace(r1.id, w.id);
    await store.addRepoToWorkspace(r2.id, w.id);
    expect((await store.listReposInWorkspace(DEFAULT_TENANT_ID, w.id)).map((r) => r.name).sort()).toEqual(["r1", "r2"]);
    expect(await store.getRepoWorkspaceId(r1.id)).toBe(w.id);
    await store.removeRepoFromWorkspace(r1.id);
    expect(await store.getRepoWorkspaceId(r1.id)).toBeNull();
    expect((await store.listReposInWorkspace(DEFAULT_TENANT_ID, w.id)).map((r) => r.name)).toEqual(["r2"]);
    await db.close();
  });

  it("addRepoToWorkspace rejects cross-tenant attachment", async () => {
    const { db, store } = await freshStore();
    const tA = await store.createTenant({ name: "A", slug: "x-a" });
    const tB = await store.createTenant({ name: "B", slug: "x-b" });
    const wA = await store.createWorkspace({ tenant_id: tA.id, slug: "w", name: "W" });
    const repoB = await store.createRepo({ tenant_id: tB.id, repo_url: "file:///b", name: "b" });
    (await expect(store.addRepoToWorkspace(repoB.id, wA.id))).rejects.toThrow(/different tenants/);
    await db.close();
  });

  it("softDeleteWorkspace refuses if repos are still attached, allows force", async () => {
    const { db, store } = await freshStore();
    const w = await store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "del", name: "Del" });
    const r = await store.createRepo({ tenant_id: DEFAULT_TENANT_ID, repo_url: "file:///del", name: "delr" });
    await store.addRepoToWorkspace(r.id, w.id);
    (await expect(store.softDeleteWorkspace(w.id))).rejects.toThrow(/attached repo/);
    expect((await store.getWorkspaceBySlug(DEFAULT_TENANT_ID, "del"))?.id).toBe(w.id);
    await store.softDeleteWorkspace(w.id, { force: true });
    expect(await store.getWorkspaceBySlug(DEFAULT_TENANT_ID, "del")).toBeNull();
    expect(await store.getRepoWorkspaceId(r.id)).toBeNull();
    // Repo itself is not deleted, just detached.
    expect((await store.getRepo(DEFAULT_TENANT_ID, r.id))?.name).toBe("delr");
    await db.close();
  });

  it("softDeleteWorkspace works without force when no repos are attached", async () => {
    const { db, store } = await freshStore();
    const w = await store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "empty", name: "Empty" });
    await store.softDeleteWorkspace(w.id);
    expect(await store.getWorkspace(w.id)).toBeNull();
    expect(await store.getWorkspaceBySlug(DEFAULT_TENANT_ID, "empty")).toBeNull();
    await db.close();
  });

  it("getWorkspace excludes soft-deleted rows", async () => {
    const { db, store } = await freshStore();
    const w = await store.createWorkspace({ tenant_id: DEFAULT_TENANT_ID, slug: "sd", name: "SD" });
    await store.softDeleteWorkspace(w.id);
    expect(await store.getWorkspace(w.id)).toBeNull();
    expect((await store.listWorkspaces(DEFAULT_TENANT_ID)).map((x) => x.slug)).not.toContain("sd");
    await db.close();
  });

  it("listReposInWorkspace is tenant-scoped (cannot leak across tenants)", async () => {
    const { db, store } = await freshStore();
    const tA = await store.createTenant({ name: "A", slug: "scope-a" });
    const tB = await store.createTenant({ name: "B", slug: "scope-b" });
    const wA = await store.createWorkspace({ tenant_id: tA.id, slug: "scope-w", name: "WA" });
    const rA = await store.createRepo({ tenant_id: tA.id, repo_url: "file:///scope-a", name: "rA" });
    await store.addRepoToWorkspace(rA.id, wA.id);
    // Use the right tenant -> sees the repo.
    expect((await store.listReposInWorkspace(tA.id, wA.id)).map((r) => r.name)).toEqual(["rA"]);
    // Use the other tenant -> sees nothing.
    expect(await store.listReposInWorkspace(tB.id, wA.id)).toEqual([]);
    await db.close();
  });
});
