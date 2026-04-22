/**
 * API key management for multi-tenant auth.
 *
 * Keys follow the format: ark_<tenantId>_<random>
 * The key hash is SHA-256 (API keys are high-entropy, so bcrypt is unnecessary).
 */

import { createHash, randomBytes } from "crypto";
import type { DatabaseAdapter } from "../database/index.js";
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
  deleted_at: string | null;
  deleted_by: string | null;
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
    deletedAt: row.deleted_at ?? null,
    deletedBy: row.deleted_by ?? null,
  };
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ── ApiKeyManager ────────────────────────────────────────────────────────────

export class ApiKeyManager {
  constructor(private db: DatabaseAdapter) {}

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
   *
   * Soft-deleted keys (migration 006) never match -- the SELECT filters on
   * `deleted_at IS NULL` so tombstoned rows can't authenticate even if
   * their hash collides with a live row in a different tenant. The partial
   * unique index `idx_api_keys_hash_live` guarantees uniqueness among
   * live rows.
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
      .prepare("SELECT * FROM api_keys WHERE key_hash = ? AND tenant_id = ? AND deleted_at IS NULL")
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
   * List all live API keys for a tenant (key hashes are included but not the plaintext keys).
   * Soft-deleted rows are hidden by default; pass `{ includeDeleted: true }` to see them.
   */
  async list(tenantId: string, opts: { includeDeleted?: boolean } = {}): Promise<ApiKey[]> {
    const sql = opts.includeDeleted
      ? "SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC"
      : "SELECT * FROM api_keys WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC";
    const rows = (await this.db.prepare(sql).all(tenantId)) as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  /**
   * Revoke (soft-delete) an API key by id. Sets `deleted_at` + `deleted_by`
   * so the audit trail survives. Idempotent: calling on an already-revoked
   * key returns `true` without overwriting the original audit fields.
   *
   * When `tenantId` is provided the revoke is scoped to that tenant so a
   * caller in tenant A cannot revoke tenant B's keys by guessing an id.
   * When omitted (local CLI / admin tooling) the key is revoked regardless
   * of tenant -- callers that reach this path already hold the local DB
   * file and have full access anyway.
   *
   * `deletedBy` records who revoked the key (from `ctx.userId`). Null means
   * "system" deleter.
   */
  async revoke(id: string, tenantId?: string, deletedBy: string | null = null): Promise<boolean> {
    const lookupSql = tenantId
      ? "SELECT deleted_at FROM api_keys WHERE id = ? AND tenant_id = ?"
      : "SELECT deleted_at FROM api_keys WHERE id = ?";
    const existing = (await (tenantId
      ? this.db.prepare(lookupSql).get(id, tenantId)
      : this.db.prepare(lookupSql).get(id))) as { deleted_at: string | null } | undefined;
    if (!existing) return false;
    if (existing.deleted_at) return true;

    const ts = now();
    if (tenantId) {
      const res = await this.db
        .prepare(
          "UPDATE api_keys SET deleted_at = ?, deleted_by = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
        )
        .run(ts, deletedBy, id, tenantId);
      return res.changes > 0;
    }
    const res = await this.db
      .prepare("UPDATE api_keys SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL")
      .run(ts, deletedBy, id);
    return res.changes > 0;
  }

  /**
   * Restore a soft-deleted API key. Clears both `deleted_at` and
   * `deleted_by`. Used by admin tooling to undo an accidental revoke.
   * Tenant scoping matches `revoke()` so one tenant can't resurrect
   * another tenant's tombstones.
   */
  async restore(id: string, tenantId?: string): Promise<boolean> {
    if (tenantId) {
      const res = await this.db
        .prepare(
          "UPDATE api_keys SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL",
        )
        .run(id, tenantId);
      return res.changes > 0;
    }
    const res = await this.db
      .prepare("UPDATE api_keys SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL")
      .run(id);
    return res.changes > 0;
  }

  /**
   * Rotate an API key: revoke the old one and create a new one with the same metadata.
   *
   * When `tenantId` is provided the lookup and revoke are scoped to that
   * tenant -- this prevents a caller from rotating another tenant's keys
   * (which would both invalidate the victim's key and leak a new key
   * belonging to the victim's tenant back to the attacker).
   *
   * Rotate looks up only live rows: a tombstoned key cannot be rotated.
   */
  async rotate(id: string, tenantId?: string, deletedBy: string | null = null): Promise<{ key: string } | null> {
    const sql = tenantId
      ? "SELECT * FROM api_keys WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL"
      : "SELECT * FROM api_keys WHERE id = ? AND deleted_at IS NULL";
    const row = (await (tenantId ? this.db.prepare(sql).get(id, tenantId) : this.db.prepare(sql).get(id))) as
      | ApiKeyRow
      | undefined;
    if (!row) return null;

    await this.revoke(id, tenantId, deletedBy);
    const result = await this.create(row.tenant_id, row.name, row.role as ApiKey["role"], row.expires_at ?? undefined);
    return { key: result.key };
  }
}
