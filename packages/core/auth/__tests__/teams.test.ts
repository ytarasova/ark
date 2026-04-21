import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { TenantManager } from "../tenants.js";
import { TeamManager } from "../teams.js";
import { UserManager } from "../users.js";

async function freshDb(): Promise<IDatabase> {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  await new MigrationRunner(db, "sqlite").apply();
  return db;
}

describe("TeamManager", () => {
  it("creates, lists, updates, deletes teams", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "t1", name: "T1" });
    const tm = new TeamManager(db);

    const eng = await tm.create({ tenant_id: tenant.id, slug: "eng", name: "Engineering" });
    const ops = await tm.create({ tenant_id: tenant.id, slug: "ops", name: "Ops" });

    const list = await tm.listByTenant(tenant.id);
    expect(list.map((t) => t.slug).sort()).toEqual(["eng", "ops"]);

    const updated = await tm.update(eng.id, { description: "Builds stuff" });
    expect(updated?.description).toBe("Builds stuff");

    const ok = await tm.delete(ops.id);
    expect(ok).toBe(true);
    expect(await tm.get(ops.id)).toBeNull();
    // Soft-deleted team is still there with includeDeleted
    const ghost = await tm.get(ops.id, { includeDeleted: true });
    expect(ghost?.id).toBe(ops.id);
    expect(ghost?.deleted_at).not.toBeNull();

    await db.close();
  });

  it("soft-delete cascades to memberships + restore brings back the team", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "sd", name: "SD" });
    const tm = new TeamManager(db);
    const users = new UserManager(db);
    const team = await tm.create({ tenant_id: tenant.id, slug: "eng", name: "Eng" });
    const u = await users.create({ email: "sd@example.com" });
    await tm.addMember(team.id, u.id, "member");

    await tm.delete(team.id);
    expect(await tm.listMembers(team.id)).toHaveLength(0);
    expect(await tm.listMembers(team.id, { includeDeleted: true })).toHaveLength(1);

    expect(await tm.restore(team.id)).toBe(true);
    const restored = await tm.get(team.id);
    expect(restored?.deleted_at).toBeNull();

    await db.close();
  });

  it("recreating a team slug after soft-delete succeeds", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "rr", name: "RR" });
    const tm = new TeamManager(db);
    const first = await tm.create({ tenant_id: tenant.id, slug: "squad", name: "First" });
    await tm.delete(first.id);
    const second = await tm.create({ tenant_id: tenant.id, slug: "squad", name: "Second" });
    expect(second.id).not.toBe(first.id);
    await db.close();
  });

  it("slug is unique within tenant but NOT across tenants", async () => {
    const db = await freshDb();
    const t1 = await new TenantManager(db).create({ slug: "one", name: "One" });
    const t2 = await new TenantManager(db).create({ slug: "two", name: "Two" });
    const tm = new TeamManager(db);

    await tm.create({ tenant_id: t1.id, slug: "eng", name: "E1" });
    await expect(tm.create({ tenant_id: t1.id, slug: "eng", name: "dup" })).rejects.toThrow(/already exists/);
    await tm.create({ tenant_id: t2.id, slug: "eng", name: "E2" });

    await db.close();
  });

  it("manages memberships: add, set-role, remove, list", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "m", name: "M" });
    const team = await new TeamManager(db).create({ tenant_id: tenant.id, slug: "eng", name: "Eng" });
    const tm = new TeamManager(db);
    const users = new UserManager(db);

    const alice = await users.create({ email: "alice@example.com", name: "Alice" });
    const bob = await users.create({ email: "bob@example.com" });

    await tm.addMember(team.id, alice.id, "admin");
    await tm.addMember(team.id, bob.id, "member");

    const members = await tm.listMembers(team.id);
    expect(members.length).toBe(2);
    const aliceRow = members.find((m) => m.email === "alice@example.com");
    expect(aliceRow?.role).toBe("admin");
    expect(aliceRow?.name).toBe("Alice");

    await tm.addMember(team.id, alice.id, "owner");
    const after = await tm.listMembers(team.id);
    expect(after.find((m) => m.email === "alice@example.com")?.role).toBe("owner");

    await tm.setRole(team.id, bob.id, "viewer");
    const latest = await tm.listMembers(team.id);
    expect(latest.find((m) => m.email === "bob@example.com")?.role).toBe("viewer");

    const ok = await tm.removeMember(team.id, bob.id);
    expect(ok).toBe(true);
    const final = await tm.listMembers(team.id);
    expect(final.map((m) => m.email)).toEqual(["alice@example.com"]);

    // removeMember is soft -- ghost is visible with includeDeleted
    const ghostList = await tm.listMembers(team.id, { includeDeleted: true });
    expect(ghostList.map((m) => m.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);

    // removeMember is idempotent
    expect(await tm.removeMember(team.id, bob.id)).toBe(true);

    // restoreMember un-soft-deletes
    expect(await tm.restoreMember(team.id, bob.id)).toBe(true);
    const reinstated = await tm.listMembers(team.id);
    expect(reinstated.map((m) => m.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);

    await db.close();
  });

  it("rejects invalid roles", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "r", name: "R" });
    const team = await new TeamManager(db).create({ tenant_id: tenant.id, slug: "eng", name: "Eng" });
    const user = await new UserManager(db).create({ email: "r@example.com" });
    const tm = new TeamManager(db);

    await expect(tm.addMember(team.id, user.id, "god" as any)).rejects.toThrow(/Invalid role/);
    await db.close();
  });
});
