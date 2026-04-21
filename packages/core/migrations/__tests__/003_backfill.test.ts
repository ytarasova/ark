import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database/index.js";
import { MigrationRunner } from "../runner.js";

async function freshDb(): Promise<IDatabase> {
  return new BunSqliteAdapter(new Database(":memory:"));
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
        "INSERT INTO compute (name, provider, compute_kind, runtime_kind, status, tenant_id, created_at, updated_at) VALUES (?, 'local', 'local', 'direct', 'running', ?, ?, ?)",
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
});
