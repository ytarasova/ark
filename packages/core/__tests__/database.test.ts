import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../database/index.js";
import type { IDatabase, IStatement } from "../database/index.js";

describe("BunSqliteAdapter", () => {
  let adapter: BunSqliteAdapter;

  beforeAll(() => {
    adapter = new BunSqliteAdapter(new Database(":memory:"));
  });

  afterAll(() => {
    adapter.close();
  });

  test("implements IDatabase interface", () => {
    const db: IDatabase = adapter;
    expect(typeof db.prepare).toBe("function");
    expect(typeof db.exec).toBe("function");
    expect(typeof db.transaction).toBe("function");
    expect(typeof db.close).toBe("function");
  });

  test("exec creates tables", () => {
    adapter.exec(`
      CREATE TABLE test_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value INTEGER NOT NULL DEFAULT 0
      )
    `);
    // If we get here without throwing, the table was created
    const stmt = adapter.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_items'");
    const row = stmt.get() as { name: string } | undefined;
    expect(row?.name).toBe("test_items");
  });

  test("prepare returns IStatement", () => {
    const stmt: IStatement = adapter.prepare("SELECT 1 as val");
    expect(typeof stmt.run).toBe("function");
    expect(typeof stmt.get).toBe("function");
    expect(typeof stmt.all).toBe("function");
  });

  test("run inserts rows and returns changes", () => {
    const result = adapter.prepare(
      "INSERT INTO test_items (name, value) VALUES (?, ?)"
    ).run("alpha", 10);
    expect(result.changes).toBe(1);
  });

  test("get retrieves a single row", () => {
    const row = adapter.prepare(
      "SELECT * FROM test_items WHERE name = ?"
    ).get("alpha") as { id: number; name: string; value: number };
    expect(row.name).toBe("alpha");
    expect(row.value).toBe(10);
  });

  test("all retrieves multiple rows", () => {
    adapter.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)").run("beta", 20);
    adapter.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)").run("gamma", 30);

    const rows = adapter.prepare("SELECT * FROM test_items ORDER BY id ASC").all() as {
      id: number; name: string; value: number;
    }[];
    expect(rows.length).toBe(3);
    expect(rows[0].name).toBe("alpha");
    expect(rows[1].name).toBe("beta");
    expect(rows[2].name).toBe("gamma");
  });

  test("transaction runs atomically", () => {
    const result = adapter.transaction(() => {
      adapter.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)").run("tx1", 100);
      adapter.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)").run("tx2", 200);
      return "done";
    });
    expect(result).toBe("done");

    const rows = adapter.prepare(
      "SELECT * FROM test_items WHERE name IN ('tx1', 'tx2') ORDER BY name"
    ).all() as { name: string; value: number }[];
    expect(rows.length).toBe(2);
    expect(rows[0].value).toBe(100);
    expect(rows[1].value).toBe(200);
  });

  test("transaction rolls back on error", () => {
    const countBefore = (adapter.prepare("SELECT COUNT(*) as c FROM test_items").get() as { c: number }).c;

    try {
      adapter.transaction(() => {
        adapter.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)").run("rollback1", 999);
        throw new Error("forced rollback");
      });
    } catch (e: any) {
      expect(e.message).toBe("forced rollback");
    }

    const countAfter = (adapter.prepare("SELECT COUNT(*) as c FROM test_items").get() as { c: number }).c;
    expect(countAfter).toBe(countBefore);
  });

  test("close shuts down without error", () => {
    const tempAdapter = new BunSqliteAdapter(new Database(":memory:"));
    tempAdapter.exec("CREATE TABLE tmp (id INTEGER PRIMARY KEY)");
    tempAdapter.close();
    // After close, operations should throw
    expect(() => tempAdapter.prepare("SELECT 1")).toThrow();
  });
});
