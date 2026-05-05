/**
 * Migration 013 -- retag legacy eval knowledge nodes from type='session'
 * (with metadata.eval = true) to the dedicated type='eval_session'.
 *
 * Pre-013 the eval harness wrote rows as `type: "session"` and flagged
 * them with `metadata.eval = true`. Those rows lived in the same
 * namespace as production sessions, so every buildContext() read leaked
 * eval noise into auto-injected agent prompts (#480). The retag creates
 * a clean namespace split that the store/search code now relies on.
 *
 * Verifies:
 *   1. Eval rows get retagged; production rows stay put.
 *   2. Re-running is a no-op (idempotent).
 *   3. Runs on a fresh install with no pre-existing rows (no crash).
 *   4. Rows whose `metadata.eval` is missing or falsy are untouched.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/types.js";
import { MigrationRunner } from "../runner.js";
import { up as up013, VERSION as V013 } from "../013_eval_session_type.js";

async function freshDb(): Promise<DatabaseAdapter> {
  return new BunSqliteAdapter(new Database(":memory:"));
}

async function insertKnowledge(
  db: DatabaseAdapter,
  id: string,
  type: string,
  label: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const ts = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO knowledge (id, type, label, content, metadata, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, type, label, null, JSON.stringify(metadata), "default", ts, ts);
}

describe("Migration 013 -- eval_session type split", () => {
  it("retags type='session' + metadata.eval=true to 'eval_session'", async () => {
    const db = await freshDb();

    // Run all migrations up to but not including 013, then manually seed
    // legacy-shape rows so we can observe the retag.
    await new MigrationRunner(db, "sqlite").apply({ targetVersion: V013 - 1 });

    await insertKnowledge(db, "eval:legacy-1", "session", "eval node 1", { eval: true });
    await insertKnowledge(db, "eval:legacy-2", "session", "eval node 2", { eval: true, other: "x" });
    await insertKnowledge(db, "prod:1", "session", "prod session 1", { eval: false });
    await insertKnowledge(db, "prod:2", "session", "prod session 2", {});
    await insertKnowledge(db, "mem:1", "memory", "a memory", { eval: true }); // wrong type, must not retag
    await insertKnowledge(db, "prod:3", "session", "prod session 3", { summary: "x" });

    await new MigrationRunner(db, "sqlite").apply();

    const rows = (await db.prepare("SELECT id, type FROM knowledge ORDER BY id").all()) as Array<{
      id: string;
      type: string;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.type]));

    expect(byId["eval:legacy-1"]).toBe("eval_session");
    expect(byId["eval:legacy-2"]).toBe("eval_session");
    expect(byId["prod:1"]).toBe("session");
    expect(byId["prod:2"]).toBe("session");
    expect(byId["prod:3"]).toBe("session");
    // Wrong-type rows never flip, even with metadata.eval=true.
    expect(byId["mem:1"]).toBe("memory");

    await db.close();
  });

  it("is idempotent -- re-running retags nothing (no rows match)", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply({ targetVersion: V013 - 1 });

    await insertKnowledge(db, "eval:a", "session", "a", { eval: true });
    await new MigrationRunner(db, "sqlite").apply();

    const first = (await db.prepare("SELECT COUNT(*) AS c FROM knowledge WHERE type = 'eval_session'").get()) as {
      c: number;
    };
    expect(first.c).toBe(1);

    // Re-run the migration body directly; the WHERE type='session' predicate
    // means already-retagged rows no longer match.
    await up013({ db, dialect: "sqlite" });

    const second = (await db.prepare("SELECT COUNT(*) AS c FROM knowledge WHERE type = 'eval_session'").get()) as {
      c: number;
    };
    expect(second.c).toBe(1);

    await db.close();
  });

  it("is a no-op on a fresh install with no rows", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    const count = (await db.prepare("SELECT COUNT(*) AS c FROM knowledge").get()) as { c: number };
    expect(count.c).toBe(0);

    // Target version reflects the full migration stream.
    expect(V013).toBe(13);
    await db.close();
  });

  it("leaves rows with metadata.eval missing or falsy untouched", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply({ targetVersion: V013 - 1 });

    await insertKnowledge(db, "s:no-eval-key", "session", "no eval key", {});
    await insertKnowledge(db, "s:eval-false", "session", "eval false", { eval: false });
    await insertKnowledge(db, "s:eval-zero", "session", "eval zero", { eval: 0 });
    // A literal string "true" also flips (the SQL matches `IN (1, 'true')`),
    // mirroring the Postgres `->> 'eval' = 'true'` predicate.
    await insertKnowledge(db, "s:eval-str-true", "session", "eval str true", { eval: "true" });

    await new MigrationRunner(db, "sqlite").apply();

    const typeFor = async (id: string): Promise<string> => {
      const row = (await db.prepare("SELECT type FROM knowledge WHERE id = ?").get(id)) as { type: string };
      return row.type;
    };

    expect(await typeFor("s:no-eval-key")).toBe("session");
    expect(await typeFor("s:eval-false")).toBe("session");
    expect(await typeFor("s:eval-zero")).toBe("session");
    expect(await typeFor("s:eval-str-true")).toBe("eval_session");

    await db.close();
  });
});
