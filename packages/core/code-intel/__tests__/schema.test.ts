import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { TABLE_MODULES, sqliteSchema, postgresSchema } from "../schema/index.js";

describe("schema DDL emitters", () => {
  it("emits 14 Wave 1 tables", () => {
    expect(TABLE_MODULES.length).toBe(14);
  });

  it("each table module exports a non-empty SQLite DDL", () => {
    for (const m of TABLE_MODULES) {
      const ddl = m.sqliteDDL();
      expect(ddl).toContain("CREATE TABLE");
      expect(ddl).toContain(m.TABLE);
    }
  });

  it("each table module exports a non-empty Postgres DDL", () => {
    for (const m of TABLE_MODULES) {
      const ddl = m.postgresDDL();
      expect(ddl).toContain("CREATE TABLE");
      expect(ddl).toContain(m.TABLE);
    }
  });

  it("aggregated SQLite schema applies cleanly to an in-memory DB", () => {
    const raw = new Database(":memory:");
    const db = new BunSqliteAdapter(raw);
    const apply = () => db.exec(sqliteSchema());
    expect(apply).not.toThrow();
    db.close();
  });

  it("re-applying the SQLite schema is idempotent", () => {
    const raw = new Database(":memory:");
    const db = new BunSqliteAdapter(raw);
    db.exec(sqliteSchema());
    const reapply = () => db.exec(sqliteSchema());
    expect(reapply).not.toThrow();
    db.close();
  });

  it("Postgres DDL contains UUID primary keys", () => {
    const text = postgresSchema();
    expect(text).toContain("UUID PRIMARY KEY");
    expect(text).toContain("JSONB");
    expect(text).toContain("TIMESTAMPTZ");
  });

  it("SQLite DDL contains TEXT primary keys (UUIDs stored as TEXT)", () => {
    const text = sqliteSchema();
    expect(text).toContain("TEXT PRIMARY KEY");
    expect(text).toContain("VIRTUAL TABLE");
    expect(text).toContain("fts5");
  });
});
