import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { TenantManager } from "../tenants.js";
import { TeamManager } from "../teams.js";
import { UserManager } from "../users.js";

async function freshDb(): Promise<IDatabase> {
  const raw = new Database(":memory:");
  // Enable FKs so ON DELETE CASCADE fires -- bun:sqlite defaults to off.
  raw.exec("PRAGMA foreign_keys = ON");
  const db = new BunSqliteAdapter(raw);
  await new MigrationRunner(db, "sqlite").apply();
  return db;
}

describe("TenantManager", () => {
  it("creates, lists, gets, updates, deletes tenants", async () => {
    const db = await freshDb();
    const tm = new TenantManager(db);

    const a = await tm.create({ slug: "acme", name: "Acme Inc" });
    expect(a.slug).toBe("acme");
    expect(a.status).toBe("active");

    const b = await tm.create({ slug: "globex", name: "Globex" });

    const list = await tm.list();
    const slugs = list.map((t) => t.slug);
    expect(slugs).toContain("acme");
    expect(slugs).toContain("globex");
    expect(slugs).toContain("default");

    const byId = await tm.get(a.id);
    expect(byId?.slug).toBe("acme");
    const bySlug = await tm.get("acme");
    expect(bySlug?.id).toBe(a.id);

    const updated = await tm.update(a.id, { name: "Acme Corp" });
    expect(updated?.name).toBe("Acme Corp");

    await tm.setStatus(b.id, "suspended");
    const suspended = await tm.get(b.id);
    expect(suspended?.status).toBe("suspended");

    const ok = await tm.delete(a.id);
    expect(ok).toBe(true);
    // Soft-delete: list() and get() hide the row by default.
    expect(await tm.get(a.id)).toBeNull();
    const listAfter = await tm.list();
    expect(listAfter.some((t) => t.id === a.id)).toBe(false);
    // But it's still there -- findable with includeDeleted.
    const ghost = await tm.get(a.id, { includeDeleted: true });
    expect(ghost?.id).toBe(a.id);
    expect(ghost?.deleted_at).not.toBeNull();

    await db.close();
  });

  it("soft-delete is idempotent + restore un-soft-deletes", async () => {
    const db = await freshDb();
    const tm = new TenantManager(db);
    const t = await tm.create({ slug: "idem", name: "Idem" });

    expect(await tm.delete(t.id)).toBe(true);
    expect(await tm.delete(t.id)).toBe(true); // already deleted -> still ok
    expect(await tm.get(t.id)).toBeNull();

    expect(await tm.restore(t.id)).toBe(true);
    const restored = await tm.get(t.id);
    expect(restored?.id).toBe(t.id);
    expect(restored?.deleted_at).toBeNull();

    await db.close();
  });

  it("soft-deleted slug can be recreated (partial unique index)", async () => {
    const db = await freshDb();
    const tm = new TenantManager(db);

    const first = await tm.create({ slug: "reuse", name: "First" });
    await tm.delete(first.id);

    const second = await tm.create({ slug: "reuse", name: "Second" });
    expect(second.id).not.toBe(first.id);

    const list = await tm.list({ includeDeleted: true });
    const reuseRows = list.filter((t) => t.slug === "reuse");
    expect(reuseRows.length).toBe(2);

    await db.close();
  });

  it("rejects duplicate slugs", async () => {
    const db = await freshDb();
    const tm = new TenantManager(db);
    await tm.create({ slug: "dup", name: "A" });
    await expect(tm.create({ slug: "dup", name: "B" })).rejects.toThrow(/already exists/);
    await db.close();
  });

  it("rejects invalid slugs", async () => {
    const db = await freshDb();
    const tm = new TenantManager(db);
    await expect(tm.create({ slug: "Bad Slug!", name: "x" })).rejects.toThrow(/Invalid slug/);
    await expect(tm.create({ slug: "-leading", name: "x" })).rejects.toThrow(/Invalid slug/);
    await db.close();
  });
});

describe("TenantManager cascade delete", () => {
  it("soft-cascades to teams and memberships on delete in one txn", async () => {
    const db = await freshDb();
    const tm = new TenantManager(db);
    const teams = new TeamManager(db);
    const users = new UserManager(db);

    const tenant = await tm.create({ slug: "casc", name: "Cascade" });
    const team = await teams.create({ tenant_id: tenant.id, slug: "eng", name: "Engineering" });
    const user = await users.create({ email: "a@b.com" });
    await teams.addMember(team.id, user.id, "member");

    await tm.delete(tenant.id);

    // Default list() calls hide the soft-deleted child rows.
    const remaining = await teams.listByTenant(tenant.id);
    expect(remaining.length).toBe(0);
    const members = await teams.listMembers(team.id);
    expect(members.length).toBe(0);

    // But with includeDeleted they come back with deleted_at populated.
    const ghostTeams = await teams.listByTenant(tenant.id, { includeDeleted: true });
    expect(ghostTeams.length).toBe(1);
    expect(ghostTeams[0].deleted_at).not.toBeNull();
    const ghostMembers = await teams.listMembers(team.id, { includeDeleted: true });
    expect(ghostMembers.length).toBe(1);
    expect(ghostMembers[0].deleted_at).not.toBeNull();

    await db.close();
  });
});
