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

    await db.close();
  });

  it("rejects invalid emails", async () => {
    const db = await freshDb();
    const um = new UserManager(db);
    await expect(um.create({ email: "not-an-email" })).rejects.toThrow(/Invalid email/);
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
