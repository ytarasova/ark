/**
 * MigrationRunner hardening tests.
 *
 * Part of the drizzle cutover (Phase A).
 *
 * Covers the two correctness properties added to `apply()`:
 *   1. Each migration's `up()` + `recordApplied()` run inside a single
 *      `db.transaction()`. If the body throws, the apply-log row must
 *      not be written.
 *   2. Postgres boot takes `pg_advisory_lock(hashtext('ark_migrations'))`
 *      before applying, releasing after. SQLite path is a documented
 *      no-op.
 *
 * The advisory-lock assertion is Postgres-specific and gated on
 * `DATABASE_URL`. The transaction-wrap assertion runs on SQLite (the
 * default local path) and exercises the same code that the Postgres
 * runner uses.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { MigrationRunner } from "../runner.js";
import type { Migration } from "../types.js";

describe("MigrationRunner hardening -- transaction wrap", () => {
  it("rolls back the apply-log row when up() throws", async () => {
    const db = new BunSqliteAdapter(new Database(":memory:"));

    const good: Migration = {
      version: 1,
      name: "good",
      up: async (ctx) => {
        await ctx.db.exec("CREATE TABLE good_table (id INTEGER)");
      },
    };

    const bad: Migration = {
      version: 2,
      name: "bad",
      up: async () => {
        throw new Error("boom");
      },
    };

    const runner = new MigrationRunner(db, "sqlite", [good, bad]);

    // First migration must succeed; second must roll back the apply-log row.
    await expect(runner.apply()).rejects.toThrow(/boom/);

    const status = await runner.status();
    expect(status.currentVersion).toBe(1);
    expect(status.applied.find((a) => a.version === 2)).toBeUndefined();
    expect(status.pending.find((p) => p.version === 2)).toBeDefined();

    await db.close();
  });

  it("commits the apply-log row atomically with up()", async () => {
    const db = new BunSqliteAdapter(new Database(":memory:"));

    const one: Migration = {
      version: 1,
      name: "one",
      up: async (ctx) => {
        await ctx.db.exec("CREATE TABLE widgets (id INTEGER)");
      },
    };

    const runner = new MigrationRunner(db, "sqlite", [one]);
    await runner.apply();

    const widgets = await db.prepare(`SELECT name FROM sqlite_master WHERE name='widgets'`).get();
    expect(widgets).toBeTruthy();

    const logged = (await db.prepare(`SELECT version FROM ark_schema_migrations WHERE version=?`).get(1)) as
      | { version: number }
      | undefined;
    expect(logged?.version).toBe(1);

    await db.close();
  });
});

describe("MigrationRunner hardening -- advisory lock (postgres)", async () => {
  const url = process.env.DATABASE_URL;
  const isPg = !!url && (url.startsWith("postgres://") || url.startsWith("postgresql://"));

  if (!isPg) {
    it.skip("DATABASE_URL not set -- skipping advisory-lock test", () => {});
    return;
  }

  it("holds pg_advisory_lock across the apply loop and releases it", async () => {
    const { PostgresAdapter } = await import("../../database/postgres.js");
    const db = new PostgresAdapter(url as string);
    const schema = `ark_lock_test_${Date.now()}`;
    await db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await db.exec(`SET search_path TO ${schema}`);

    try {
      const runner = new MigrationRunner(db, "postgres");
      await runner.apply();

      // After apply completes, the advisory lock must be released. Another
      // session must be able to acquire it. Use try-lock (non-blocking) to
      // detect stuck locks -- if apply() leaked the lock, try_lock would
      // return false.
      const row = (await db.prepare(`SELECT pg_try_advisory_lock(hashtext('ark_migrations')) AS got`).get()) as
        | { got: boolean }
        | undefined;
      expect(row?.got).toBe(true);
      await db.prepare(`SELECT pg_advisory_unlock(hashtext('ark_migrations'))`).run();
    } finally {
      await db.exec(`DROP SCHEMA ${schema} CASCADE`);
      await db.close();
    }
  });
});
