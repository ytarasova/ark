/**
 * Tests for TenantClaudeAuthManager -- per-tenant Claude credential
 * binding (api_key | subscription_blob).
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { TenantClaudeAuthManager } from "../tenant-claude-auth.js";

const PRAGMA_FK_ON = "PRAGMA foreign_keys = ON";

async function freshDb(): Promise<DatabaseAdapter> {
  const raw = new Database(":memory:");
  // Enable FKs for parity with production -- bun:sqlite defaults to off.
  (raw as { exec(sql: string): void }).exec(PRAGMA_FK_ON);
  const db = new BunSqliteAdapter(raw);
  await new MigrationRunner(db, "sqlite").apply();
  return db;
}

describe("TenantClaudeAuthManager", () => {
  it("set with api_key persists and get returns the row", async () => {
    const db = await freshDb();
    const m = new TenantClaudeAuthManager(db);
    const row = await m.set("tenant-a", "api_key", "ANTHROPIC_API_KEY");
    expect(row.tenant_id).toBe("tenant-a");
    expect(row.kind).toBe("api_key");
    expect(row.secret_ref).toBe("ANTHROPIC_API_KEY");
    const fetched = await m.get("tenant-a");
    expect(fetched).not.toBeNull();
    expect(fetched!.kind).toBe("api_key");
    expect(fetched!.secret_ref).toBe("ANTHROPIC_API_KEY");
  });

  it("set with subscription_blob persists", async () => {
    const db = await freshDb();
    const m = new TenantClaudeAuthManager(db);
    const row = await m.set("tenant-b", "subscription_blob", "claude-subscription");
    expect(row.kind).toBe("subscription_blob");
    expect(row.secret_ref).toBe("claude-subscription");
    const fetched = await m.get("tenant-b");
    expect(fetched!.kind).toBe("subscription_blob");
  });

  it("set overwrites a prior binding", async () => {
    const db = await freshDb();
    const m = new TenantClaudeAuthManager(db);
    await m.set("t1", "api_key", "OLD_KEY");
    await m.set("t1", "subscription_blob", "claude-sub");
    const row = await m.get("t1");
    expect(row!.kind).toBe("subscription_blob");
    expect(row!.secret_ref).toBe("claude-sub");
  });

  it("clear removes the binding, then get returns null", async () => {
    const db = await freshDb();
    const m = new TenantClaudeAuthManager(db);
    await m.set("t1", "api_key", "K");
    const removed = await m.clear("t1");
    expect(removed).toBe(true);
    expect(await m.get("t1")).toBeNull();
    // Second clear is idempotent-false.
    expect(await m.clear("t1")).toBe(false);
  });

  it("rejects invalid kind", async () => {
    const db = await freshDb();
    const m = new TenantClaudeAuthManager(db);
    await expect(m.set("t1", "wat" as any, "ref")).rejects.toThrow(/Invalid claude auth kind/);
  });

  it("rejects empty secret_ref", async () => {
    const db = await freshDb();
    const m = new TenantClaudeAuthManager(db);
    await expect(m.set("t1", "api_key", "")).rejects.toThrow(/secretRef/);
  });

  it("isolates tenants", async () => {
    const db = await freshDb();
    const m = new TenantClaudeAuthManager(db);
    await m.set("t1", "api_key", "K1");
    await m.set("t2", "subscription_blob", "blob2");
    expect((await m.get("t1"))!.kind).toBe("api_key");
    expect((await m.get("t2"))!.kind).toBe("subscription_blob");
  });
});
