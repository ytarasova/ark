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
