/**
 * TenantClaudeAuthRepository -- SQL adapter over `tenant_claude_auth`.
 *
 * The table is defined in schema.ts / schema-postgres.ts + migration 007.
 * This repository keeps it to a tiny CRUD surface: a tenant either has a
 * claude-auth binding or it doesn't. Changing binding mode overwrites.
 */

import type { IDatabase } from "../database/index.js";
import { now } from "../util/time.js";

export type ClaudeAuthKind = "api_key" | "subscription_blob";

export interface TenantClaudeAuthRow {
  tenant_id: string;
  kind: ClaudeAuthKind;
  secret_ref: string;
  created_at: string;
  updated_at: string;
}

export class TenantClaudeAuthRepository {
  constructor(private db: IDatabase) {}

  async get(tenantId: string): Promise<TenantClaudeAuthRow | null> {
    const row = (await this.db.prepare("SELECT * FROM tenant_claude_auth WHERE tenant_id = ?").get(tenantId)) as
      | TenantClaudeAuthRow
      | undefined;
    return row ?? null;
  }

  /** Create-or-replace the binding. */
  async set(tenantId: string, kind: ClaudeAuthKind, secretRef: string): Promise<TenantClaudeAuthRow> {
    const ts = now();
    const existing = await this.get(tenantId);
    if (existing) {
      await this.db
        .prepare("UPDATE tenant_claude_auth SET kind = ?, secret_ref = ?, updated_at = ? WHERE tenant_id = ?")
        .run(kind, secretRef, ts, tenantId);
    } else {
      await this.db
        .prepare(
          "INSERT INTO tenant_claude_auth (tenant_id, kind, secret_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(tenantId, kind, secretRef, ts, ts);
    }
    return (await this.get(tenantId))!;
  }

  async delete(tenantId: string): Promise<boolean> {
    const res = await this.db.prepare("DELETE FROM tenant_claude_auth WHERE tenant_id = ?").run(tenantId);
    return res.changes > 0;
  }
}
