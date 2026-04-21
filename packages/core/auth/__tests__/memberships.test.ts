import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { TenantManager } from "../tenants.js";
import { TeamManager } from "../teams.js";
import { UserManager } from "../users.js";
import { MembershipRepository } from "../../repositories/memberships.js";

async function freshDb(): Promise<IDatabase> {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  await new MigrationRunner(db, "sqlite").apply();
  return db;
}

describe("MembershipRepository soft-delete", () => {
  it("softRemove hides the row from default reads", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "mb", name: "MB" });
    const team = await new TeamManager(db).create({ tenant_id: tenant.id, slug: "eng", name: "Eng" });
    const user = await new UserManager(db).create({ email: "m@example.com" });
    const repo = new MembershipRepository(db);

    await repo.add(user.id, team.id, "member");
    expect(await repo.get(user.id, team.id)).not.toBeNull();

    expect(await repo.softRemove(user.id, team.id)).toBe(true);
    expect(await repo.get(user.id, team.id)).toBeNull();

    const ghost = await repo.get(user.id, team.id, { includeDeleted: true });
    expect(ghost?.deleted_at).not.toBeNull();

    // Idempotent
    expect(await repo.softRemove(user.id, team.id)).toBe(true);

    // Restore brings it back
    expect(await repo.restore(user.id, team.id)).toBe(true);
    const back = await repo.get(user.id, team.id);
    expect(back?.deleted_at).toBeNull();

    await db.close();
  });

  it("listByTeam / listByUser hide soft-deleted rows by default", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "mb2", name: "MB2" });
    const team = await new TeamManager(db).create({ tenant_id: tenant.id, slug: "eng", name: "Eng" });
    const users = new UserManager(db);
    const a = await users.create({ email: "a@m.com" });
    const b = await users.create({ email: "b@m.com" });
    const repo = new MembershipRepository(db);

    await repo.add(a.id, team.id, "member");
    await repo.add(b.id, team.id, "member");
    await repo.softRemove(b.id, team.id);

    const byTeam = await repo.listByTeam(team.id);
    expect(byTeam.map((m) => m.email)).toEqual(["a@m.com"]);

    const byTeamAll = await repo.listByTeam(team.id, { includeDeleted: true });
    expect(byTeamAll.map((m) => m.email).sort()).toEqual(["a@m.com", "b@m.com"]);

    const byUserB = await repo.listByUser(b.id);
    expect(byUserB.length).toBe(0);
    const byUserBAll = await repo.listByUser(b.id, { includeDeleted: true });
    expect(byUserBAll.length).toBe(1);

    await db.close();
  });

  it("cascading soft-deletes from tenant reach membership rows", async () => {
    const db = await freshDb();
    const tm = new TenantManager(db);
    const teamsMgr = new TeamManager(db);
    const usersMgr = new UserManager(db);

    const tenant = await tm.create({ slug: "casc-mb", name: "C" });
    const team = await teamsMgr.create({ tenant_id: tenant.id, slug: "eng", name: "E" });
    const user = await usersMgr.create({ email: "c@m.com" });
    await teamsMgr.addMember(team.id, user.id, "member");

    await tm.delete(tenant.id);

    const repo = new MembershipRepository(db);
    const live = await repo.listByTeam(team.id);
    expect(live.length).toBe(0);
    const all = await repo.listByTeam(team.id, { includeDeleted: true });
    expect(all.length).toBe(1);
    expect(all[0].deleted_at).not.toBeNull();

    await db.close();
  });

  it("removing and re-adding a member creates a fresh live row", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "re", name: "Re" });
    const team = await new TeamManager(db).create({ tenant_id: tenant.id, slug: "eng", name: "Eng" });
    const user = await new UserManager(db).create({ email: "re@m.com" });
    const repo = new MembershipRepository(db);

    const first = await repo.add(user.id, team.id, "member");
    await repo.softRemove(user.id, team.id);
    const second = await repo.add(user.id, team.id, "admin");
    // add() on a dead row inserts a new live row because the partial unique
    // index is scoped to deleted_at IS NULL.
    expect(second.id).not.toBe(first.id);
    expect(second.role).toBe("admin");

    await db.close();
  });
});
