/**
 * TenantClaudeAuthRepository -- drizzle-backed adapter over `tenant_claude_auth`.
 *
 * The table maps a tenant to either an API-key secret or a subscription-blob
 * reference. Single-valued: `set()` overwrites the previous binding.
 */

import type { IDatabase } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { eq } from "drizzle-orm";
import { now } from "../util/time.js";

export type ClaudeAuthKind = "api_key" | "subscription_blob";

export interface TenantClaudeAuthRow {
  tenant_id: string;
  kind: ClaudeAuthKind;
  secret_ref: string;
  created_at: string;
  updated_at: string;
}

type DrizzleSelect = {
  tenantId: string;
  kind: string;
  secretRef: string;
  createdAt: string;
  updatedAt: string;
};

function toPublic(row: DrizzleSelect): TenantClaudeAuthRow {
  return {
    tenant_id: row.tenantId,
    kind: row.kind as ClaudeAuthKind,
    secret_ref: row.secretRef,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export class TenantClaudeAuthRepository {
  private _d: DrizzleClient | null = null;

  constructor(private db: IDatabase) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  async get(tenantId: string): Promise<TenantClaudeAuthRow | null> {
    const d = this.d();
    const t = d.schema.tenantClaudeAuth;
    const rows = await (d.db as any).select().from(t).where(eq(t.tenantId, tenantId)).limit(1);
    const row = (rows as DrizzleSelect[])[0];
    return row ? toPublic(row) : null;
  }

  /** Create-or-replace the binding. */
  async set(tenantId: string, kind: ClaudeAuthKind, secretRef: string): Promise<TenantClaudeAuthRow> {
    const ts = now();
    const existing = await this.get(tenantId);
    const d = this.d();
    const t = d.schema.tenantClaudeAuth;
    if (existing) {
      await (d.db as any).update(t).set({ kind, secretRef, updatedAt: ts }).where(eq(t.tenantId, tenantId));
    } else {
      await (d.db as any).insert(t).values({
        tenantId,
        kind,
        secretRef,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    return (await this.get(tenantId))!;
  }

  async delete(tenantId: string): Promise<boolean> {
    const d = this.d();
    const t = d.schema.tenantClaudeAuth;
    const res = await (d.db as any).delete(t).where(eq(t.tenantId, tenantId));
    return extractChangesLocal(res) > 0;
  }
}

function extractChangesLocal(res: unknown): number {
  if (!res || typeof res !== "object") return 0;
  const r = res as { changes?: number; rowCount?: number; count?: number };
  if (typeof r.changes === "number") return r.changes;
  if (typeof r.rowCount === "number") return r.rowCount;
  if (typeof r.count === "number") return r.count;
  return 0;
}
