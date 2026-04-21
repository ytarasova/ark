import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { UserManager } from "../users.js";

async function freshDb(): Promise<IDatabase> {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  await new MigrationRunner(db, "sqlite").apply();
  return db;
}

describe("UserManager", () => {
  it("creates, lists, gets, deletes users", async () => {
    const db = await freshDb();
    const um = new UserManager(db);

    const a = await um.create({ email: "a@example.com", name: "Alice" });
    expect(a.email).toBe("a@example.com");
    expect(a.name).toBe("Alice");

    await um.create({ email: "b@example.com" });
    const list = await um.list();
    expect(list.map((u) => u.email).sort()).toEqual(["a@example.com", "b@example.com"]);

    const byId = await um.get(a.id);
    expect(byId?.email).toBe("a@example.com");
    const byEmail = await um.get("a@example.com");
    expect(byEmail?.id).toBe(a.id);

    const ok = await um.delete(a.id);
    expect(ok).toBe(true);
    expect(await um.get(a.id)).toBeNull();
    // Soft-deleted: still findable with includeDeleted
    const ghost = await um.get(a.id, { includeDeleted: true });
    expect(ghost?.id).toBe(a.id);
    expect(ghost?.deleted_at).not.toBeNull();

    await db.close();
  });

  it("soft-delete is idempotent + restore brings the user back", async () => {
    const db = await freshDb();
    const um = new UserManager(db);
    const u = await um.create({ email: "sd@example.com" });
    expect(await um.delete(u.id)).toBe(true);
    expect(await um.delete(u.id)).toBe(true);
    expect(await um.get(u.id)).toBeNull();
    expect(await um.restore(u.id)).toBe(true);
    const back = await um.get(u.id);
    expect(back?.id).toBe(u.id);
    await db.close();
  });

  it("recreating an email after soft-delete succeeds", async () => {
    const db = await freshDb();
    const um = new UserManager(db);
    const first = await um.create({ email: "rr@example.com", name: "First" });
    await um.delete(first.id);
    const second = await um.create({ email: "rr@example.com", name: "Second" });
    expect(second.id).not.toBe(first.id);
    await db.close();
  });

  it("rejects invalid emails", async () => {
    const db = await freshDb();
    const um = new UserManager(db);
    await expect(um.create({ email: "not-an-email" })).rejects.toThrow(/Invalid email/);
    await db.close();
  });

  it("records deleted_by when delete() is called with an acting userId", async () => {
    const db = await freshDb();
    const um = new UserManager(db);
    const u = await um.create({ email: "audit@example.com" });
    await um.delete(u.id, "u-admin-1");
    const ghost = await um.get(u.id, { includeDeleted: true });
    expect(ghost?.deleted_by).toBe("u-admin-1");
    expect(ghost?.deleted_at).not.toBeNull();

    // Restore clears both fields.
    await um.restore(u.id);
    const back = await um.get(u.id);
    expect(back?.deleted_at).toBeNull();
    expect(back?.deleted_by).toBeNull();
    await db.close();
  });

  it("soft-deletes with NULL deleted_by when no actor is supplied", async () => {
    const db = await freshDb();
    const um = new UserManager(db);
    const u = await um.create({ email: "sys@example.com" });
    await um.delete(u.id);
    const ghost = await um.get(u.id, { includeDeleted: true });
    expect(ghost?.deleted_by).toBeNull();
    await db.close();
  });

  it("rejects duplicate emails on create", async () => {
    const db = await freshDb();
    const um = new UserManager(db);
    await um.create({ email: "dup@example.com" });
    await expect(um.create({ email: "dup@example.com" })).rejects.toThrow(/already exists/);
    await db.close();
  });

  it("upsertByEmail is idempotent", async () => {
    const db = await freshDb();
    const um = new UserManager(db);

    const first = await um.upsertByEmail({ email: "ups@example.com", name: "First" });
    const second = await um.upsertByEmail({ email: "ups@example.com", name: "First" });
    expect(second.id).toBe(first.id);

    const third = await um.upsertByEmail({ email: "ups@example.com", name: "Renamed" });
    expect(third.id).toBe(first.id);
    expect(third.name).toBe("Renamed");

    const list = await um.list();
    expect(list.filter((u) => u.email === "ups@example.com").length).toBe(1);

    await db.close();
  });
});
