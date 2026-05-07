import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter, PreparedStatement } from "../../database/types.js";
import { MigrationRunner } from "../runner.js";
import { up as up003, VERSION as V003 } from "../003_tenants_teams.js";

async function freshDb(): Promise<DatabaseAdapter> {
  return new BunSqliteAdapter(new Database(":memory:"));
}

/**
 * Wrap an DatabaseAdapter so every prepare() + run-ddl call is logged. Used to
 * assert that the 003 no-op guard really prevents backfill SELECTs on a
 * DB that already sits at version 3.
 */
function withSqlSpy(inner: DatabaseAdapter): { db: DatabaseAdapter; seen: string[] } {
  const seen: string[] = [];
  const db: DatabaseAdapter = {
    prepare(sql: string): PreparedStatement {
      seen.push(sql);
      return inner.prepare(sql);
    },
    exec(sql: string): Promise<void> {
      seen.push(sql);
      return inner.exec(sql);
    },
    transaction<T>(fn: () => Promise<T>): Promise<T> {
      return inner.transaction(fn);
    },
    close(): Promise<void> {
      return inner.close();
    },
  };
  return { db, seen };
}

describe("Migration 003 -- tenants backfill", () => {
  it("backfills tenants from sessions + compute + tenant_policies", async () => {
    const db = await freshDb();

    await new MigrationRunner(db, "sqlite").apply({ targetVersion: 2 });

    const ts = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO sessions (id, status, flow, tenant_id, created_at, updated_at) VALUES (?, 'pending', 'default', ?, ?, ?)",
      )
      .run("s-1", "acme", ts, ts);
    await db
      .prepare(
        "INSERT INTO sessions (id, status, flow, tenant_id, created_at, updated_at) VALUES (?, 'pending', 'default', ?, ?, ?)",
      )
      .run("s-2", "globex", ts, ts);
    await db
      .prepare(
        "INSERT INTO sessions (id, status, flow, tenant_id, created_at, updated_at) VALUES (?, 'pending', 'default', ?, ?, ?)",
      )
      .run("s-3", "acme", ts, ts);

    await db
      .prepare(
        "INSERT INTO compute (name, compute_kind, isolation_kind, status, tenant_id, created_at, updated_at) VALUES (?, 'local', 'direct', 'running', ?, ?, ?)",
      )
      .run("c-1", "initech", ts, ts);

    await db.exec(
      "CREATE TABLE IF NOT EXISTS tenant_policies (tenant_id TEXT PRIMARY KEY, allowed_providers TEXT, default_provider TEXT, max_concurrent_sessions INTEGER, max_cost_per_day_usd REAL, compute_pools TEXT, created_at TEXT, updated_at TEXT)",
    );
    await db
      .prepare(
        "INSERT INTO tenant_policies (tenant_id, allowed_providers, default_provider, max_concurrent_sessions, compute_pools, created_at, updated_at) VALUES (?, '[]', 'k8s', 10, '[]', ?, ?)",
      )
      .run("policycorp", ts, ts);

    await new MigrationRunner(db, "sqlite").apply();

    const rows = (await db.prepare("SELECT id, slug, name, status FROM tenants ORDER BY id").all()) as Array<{
      id: string;
      slug: string;
      name: string;
      status: string;
    }>;

    const ids = rows.map((r) => r.id);
    expect(ids).toContain("acme");
    expect(ids).toContain("globex");
    expect(ids).toContain("initech");
    expect(ids).toContain("policycorp");
    expect(ids).toContain("default");
    expect(rows.filter((r) => r.id === "acme").length).toBe(1);

    for (const r of rows) {
      expect(r.status).toBe("active");
    }

    await db.close();
  });

  it("re-running the migration is idempotent", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();
    const firstCount = (await db.prepare("SELECT COUNT(*) as n FROM tenants").get()) as { n: number };
    await new MigrationRunner(db, "sqlite").apply();
    const secondCount = (await db.prepare("SELECT COUNT(*) as n FROM tenants").get()) as { n: number };
    expect(secondCount.n).toBe(firstCount.n);
    await db.close();
  });

  it("always seeds the 'default' tenant", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();
    const row = (await db.prepare("SELECT id, slug, status FROM tenants WHERE id = 'default'").get()) as
      | { id: string; slug: string; status: string }
      | undefined;
    expect(row?.id).toBe("default");
    expect(row?.slug).toBe("default");
    expect(row?.status).toBe("active");
    await db.close();
  });

  it("is a no-op when ark_schema_migrations already records version >= 3", async () => {
    // Boot the DB once so migrations run and the apply-log records v3.
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    // Wrap with a spy, then call 003's up() directly. The guard should see
    // the apply-log row for v3 and short-circuit before any backfill SELECT
    // or CREATE TABLE runs against sessions / compute / tenant_policies.
    const { db: spied, seen } = withSqlSpy(db);
    await up003({ db: spied, dialect: "sqlite" });

    const touchesHotTable = (sql: string): boolean =>
      /\b(sessions|compute|tenant_policies|events|messages|todos|schedules)\b/i.test(sql);
    const offenders = seen.filter(touchesHotTable);
    expect(offenders).toEqual([]);

    // Only the guard's own SELECT against the apply-log should have fired.
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatch(/ark_schema_migrations/);

    await db.close();
  });

  it("runs backfill when the apply-log has not yet recorded v3", async () => {
    // Simulate partial state: migrations table exists and has v1, v2 but not
    // v3. 003's body MUST run in this case -- this is the fresh-upgrade path.
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply({ targetVersion: 2 });

    const ts = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO sessions (id, status, flow, tenant_id, created_at, updated_at) VALUES (?, 'pending', 'default', ?, ?, ?)",
      )
      .run("s-9", "sprocket", ts, ts);

    // Sanity: guard must see version 2, not >= 3.
    const apex = (await db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM ark_schema_migrations").get()) as {
      v: number;
    };
    expect(apex.v).toBe(2);

    await up003({ db, dialect: "sqlite" });

    const tenants = (await db.prepare("SELECT id FROM tenants ORDER BY id").all()) as Array<{ id: string }>;
    expect(tenants.map((t) => t.id)).toContain("sprocket");

    // Confirm we still tripped the target version.
    expect(V003).toBe(3);
    await db.close();
  });
});
