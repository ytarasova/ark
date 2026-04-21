/**
 * API key management for multi-tenant auth.
 *
 * Keys follow the format: ark_<tenantId>_<random>
 * The key hash is SHA-256 (API keys are high-entropy, so bcrypt is unnecessary).
 */

import { createHash, randomBytes } from "crypto";
import type { IDatabase } from "../database/index.js";
import type { TenantContext, ApiKey } from "../../types/index.js";
import { now } from "../util/time.js";

// ── Row type ─────────────────────────────────────────────────────────────────

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  key_hash: string;
  name: string;
  role: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    keyHash: row.key_hash,
    name: row.name,
    role: row.role as ApiKey["role"],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ── ApiKeyManager ────────────────────────────────────────────────────────────

export class ApiKeyManager {
  constructor(private db: IDatabase) {}

  /**
   * Create a new API key. Returns the plaintext key (only shown once) and
   * the persisted record id.
   */
  async create(
    tenantId: string,
    name: string,
    role: "admin" | "member" | "viewer" = "member",
    expiresAt?: string,
  ): Promise<{ key: string; id: string }> {
    const id = `ak-${randomBytes(4).toString("hex")}`;
    const secret = randomBytes(24).toString("hex");
    const key = `ark_${tenantId}_${secret}`;
    const keyHash = hashKey(key);
    const ts = now();

    await this.db
      .prepare(
        `
      INSERT INTO api_keys (id, tenant_id, key_hash, name, role, created_at, last_used_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `,
      )
      .run(id, tenantId, keyHash, name, role, ts, expiresAt ?? null);

    return { key, id };
  }

  /**
   * Validate an API key and return the tenant context, or null if invalid/expired.
   */
  async validate(key: string): Promise<TenantContext | null> {
    // Parse the key format: ark_<tenantId>_<secret>
    if (!key.startsWith("ark_")) return null;
    const parts = key.split("_");
    if (parts.length < 3) return null;
    // tenantId might contain underscores in the future, but for now it's the second segment
    const tenantId = parts[1];

    const keyHash = hashKey(key);
    const row = (await this.db
      .prepare("SELECT * FROM api_keys WHERE key_hash = ? AND tenant_id = ?")
      .get(keyHash, tenantId)) as ApiKeyRow | undefined;

    if (!row) return null;

    // Check expiry
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return null;
    }

    // Update last_used_at
    await this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), row.id);

    return {
      tenantId: row.tenant_id,
      userId: row.id, // API key id serves as the user identity for key-based auth
      role: row.role as TenantContext["role"],
    };
  }

  /**
   * List all API keys for a tenant (key hashes are included but not the plaintext keys).
   */
  async list(tenantId: string): Promise<ApiKey[]> {
    const rows = (await this.db
      .prepare("SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(tenantId)) as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  /**
   * Revoke (delete) an API key by id.
   *
   * When `tenantId` is provided the delete is scoped to that tenant so a
   * caller in tenant A cannot revoke tenant B's keys by guessing an id.
   * When omitted (local CLI / admin tooling) the key is removed regardless
   * of tenant -- callers that reach this path already hold the local DB
   * file and have full access anyway.
   */
  async revoke(id: string, tenantId?: string): Promise<boolean> {
    if (tenantId) {
      const result = await this.db.prepare("DELETE FROM api_keys WHERE id = ? AND tenant_id = ?").run(id, tenantId);
      return result.changes > 0;
    }
    const result = await this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * Rotate an API key: revoke the old one and create a new one with the same metadata.
   *
   * When `tenantId` is provided the lookup and delete are scoped to that
   * tenant -- this prevents a caller from rotating another tenant's keys
   * (which would both invalidate the victim's key and leak a new key
   * belonging to the victim's tenant back to the attacker).
   */
  async rotate(id: string, tenantId?: string): Promise<{ key: string } | null> {
    const sql = tenantId
      ? "SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?"
      : "SELECT * FROM api_keys WHERE id = ?";
    const row = (await (tenantId ? this.db.prepare(sql).get(id, tenantId) : this.db.prepare(sql).get(id))) as
      | ApiKeyRow
      | undefined;
    if (!row) return null;

    await this.revoke(id, tenantId);
    const result = await this.create(row.tenant_id, row.name, row.role as ApiKey["role"], row.expires_at ?? undefined);
    return { key: result.key };
  }
}
