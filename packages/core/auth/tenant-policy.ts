/**
 * Tenant compute policies -- control what compute resources each tenant
 * can use, including allowed providers, concurrency limits, and cost caps.
 *
 * The control plane is the single authority that decides what compute a
 * tenant can use and provisions it. TenantPolicyManager persists policies
 * in SQLite and provides validation helpers used by the scheduler.
 */

import type { IDatabase } from "./database/index.js";
import { logInfo, logDebug } from "../observability/structured-log.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TenantComputePolicy {
  tenant_id: string;
  allowed_providers: string[]; // ["k8s", "k8s-kata", "ec2"]
  default_provider: string; // "k8s"
  max_concurrent_sessions: number; // 20
  max_cost_per_day_usd: number | null; // budget limit
  compute_pools: ComputePoolRef[]; // pools assigned to this tenant
  // Integration settings
  router_enabled: boolean | null; // null = inherit from global config
  router_required: boolean; // tenant MUST use router (control plane enforced)
  router_policy: string | null; // "quality" | "balanced" | "cost" | null = inherit
  auto_index: boolean | null; // null = inherit from global config
  auto_index_required: boolean; // tenant MUST auto-index
  tensorzero_enabled: boolean | null; // null = inherit from global config
}

export interface ComputePoolRef {
  pool_name: string;
  provider: string;
  min: number;
  max: number;
  config: Record<string, unknown>; // provider-specific (size, image, region, etc.)
}

/** Default policy for tenants without an explicit policy record. */
const DEFAULT_POLICY: Omit<TenantComputePolicy, "tenant_id"> = {
  allowed_providers: [], // empty = all allowed
  default_provider: "k8s",
  max_concurrent_sessions: 10,
  max_cost_per_day_usd: null,
  compute_pools: [],
  router_enabled: null,
  router_required: false,
  router_policy: null,
  auto_index: null,
  auto_index_required: false,
  tensorzero_enabled: null,
};

// ── Manager ────────────────────────────────────────────────────────────────

export class TenantPolicyManager {
  constructor(private db: IDatabase) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS tenant_policies (
      tenant_id TEXT PRIMARY KEY,
      allowed_providers TEXT NOT NULL DEFAULT '[]',
      default_provider TEXT NOT NULL DEFAULT 'k8s',
      max_concurrent_sessions INTEGER NOT NULL DEFAULT 10,
      max_cost_per_day_usd REAL,
      compute_pools TEXT NOT NULL DEFAULT '[]',
      router_enabled INTEGER,
      router_required INTEGER NOT NULL DEFAULT 0,
      router_policy TEXT,
      auto_index INTEGER,
      auto_index_required INTEGER NOT NULL DEFAULT 0,
      tensorzero_enabled INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this._migrateIntegrationColumns();
  }

  private _migrateIntegrationColumns(): void {
    const cols: [string, string][] = [
      ["router_enabled", "INTEGER"],
      ["router_required", "INTEGER NOT NULL DEFAULT 0"],
      ["router_policy", "TEXT"],
      ["auto_index", "INTEGER"],
      ["auto_index_required", "INTEGER NOT NULL DEFAULT 0"],
      ["tensorzero_enabled", "INTEGER"],
    ];
    for (const [col, def] of cols) {
      try {
        this.db.prepare(`ALTER TABLE tenant_policies ADD COLUMN ${col} ${def}`).run();
      } catch {
        logInfo("general", "exists");
      }
    }
  }

  /** Get the policy for a tenant, or null if no explicit policy exists. */
  getPolicy(tenantId: string): TenantComputePolicy | null {
    const row = this.db.prepare("SELECT * FROM tenant_policies WHERE tenant_id = ?").get(tenantId) as
      | TenantPolicyRow
      | undefined;
    return row ? this._hydrateRow(row) : null;
  }

  /**
   * Get the effective policy for a tenant.
   * Returns the explicit policy if one exists, otherwise returns the default policy.
   */
  getEffectivePolicy(tenantId: string): TenantComputePolicy {
    return this.getPolicy(tenantId) ?? { tenant_id: tenantId, ...DEFAULT_POLICY };
  }

  /** Set (create or update) a tenant policy. */
  setPolicy(policy: TenantComputePolicy): void {
    const now = new Date().toISOString();
    const providers = JSON.stringify(policy.allowed_providers);
    const pools = JSON.stringify(policy.compute_pools);
    const routerEnabled = policy.router_enabled == null ? null : policy.router_enabled ? 1 : 0;
    const routerRequired = policy.router_required ? 1 : 0;
    const autoIndex = policy.auto_index == null ? null : policy.auto_index ? 1 : 0;
    const autoIndexRequired = policy.auto_index_required ? 1 : 0;
    const tensorzeroEnabled = policy.tensorzero_enabled == null ? null : policy.tensorzero_enabled ? 1 : 0;

    const existing = this.db.prepare("SELECT tenant_id FROM tenant_policies WHERE tenant_id = ?").get(policy.tenant_id);

    if (existing) {
      this.db
        .prepare(
          `
        UPDATE tenant_policies
        SET allowed_providers = ?, default_provider = ?,
            max_concurrent_sessions = ?, max_cost_per_day_usd = ?,
            compute_pools = ?,
            router_enabled = ?, router_required = ?, router_policy = ?,
            auto_index = ?, auto_index_required = ?, tensorzero_enabled = ?,
            updated_at = ?
        WHERE tenant_id = ?
      `,
        )
        .run(
          providers,
          policy.default_provider,
          policy.max_concurrent_sessions,
          policy.max_cost_per_day_usd ?? null,
          pools,
          routerEnabled,
          routerRequired,
          policy.router_policy ?? null,
          autoIndex,
          autoIndexRequired,
          tensorzeroEnabled,
          now,
          policy.tenant_id,
        );
    } else {
      this.db
        .prepare(
          `
        INSERT INTO tenant_policies
          (tenant_id, allowed_providers, default_provider,
           max_concurrent_sessions, max_cost_per_day_usd, compute_pools,
           router_enabled, router_required, router_policy,
           auto_index, auto_index_required, tensorzero_enabled,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          policy.tenant_id,
          providers,
          policy.default_provider,
          policy.max_concurrent_sessions,
          policy.max_cost_per_day_usd ?? null,
          pools,
          routerEnabled,
          routerRequired,
          policy.router_policy ?? null,
          autoIndex,
          autoIndexRequired,
          tensorzeroEnabled,
          now,
          now,
        );
    }
  }

  /** Delete a tenant policy. Returns true if a policy was deleted. */
  deletePolicy(tenantId: string): boolean {
    const result = this.db.prepare("DELETE FROM tenant_policies WHERE tenant_id = ?").run(tenantId);
    return result.changes > 0;
  }

  /** List all tenant policies. */
  listPolicies(): TenantComputePolicy[] {
    const rows = this.db.prepare("SELECT * FROM tenant_policies ORDER BY tenant_id").all() as TenantPolicyRow[];
    return rows.map((r) => this._hydrateRow(r));
  }

  // ── Validation helpers ──────────────────────────────────────────────────

  /**
   * Check if a provider is allowed for a tenant.
   * An empty allowed_providers list means all providers are allowed.
   */
  isProviderAllowed(tenantId: string, provider: string): boolean {
    const policy = this.getEffectivePolicy(tenantId);
    if (policy.allowed_providers.length === 0) return true;
    return policy.allowed_providers.includes(provider);
  }

  /**
   * Get the number of active (running) sessions for a tenant.
   * Queries the sessions table via the shared database connection.
   */
  getActiveSessions(tenantId: string): number {
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM sessions
         WHERE status = 'running' AND tenant_id = ?`,
        )
        .get(tenantId) as { cnt: number } | undefined;
      if (row) return row.cnt;
    } catch {
      logDebug("general", "tenant_id column may not exist on sessions table in some setups");
    }
    return 0;
  }

  /**
   * Check whether a tenant is allowed to dispatch a new session.
   * Returns { allowed: true } or { allowed: false, reason: "..." }.
   */
  canDispatch(tenantId: string): { allowed: boolean; reason?: string } {
    const policy = this.getEffectivePolicy(tenantId);
    const active = this.getActiveSessions(tenantId);

    if (active >= policy.max_concurrent_sessions) {
      return {
        allowed: false,
        reason: `Tenant "${tenantId}" has reached the maximum concurrent sessions limit (${policy.max_concurrent_sessions}). Active: ${active}.`,
      };
    }

    return { allowed: true };
  }

  /** Get effective integration settings: tenant policy -> global config fallback. */
  getEffectiveIntegrationSettings(
    tenantId: string,
    globalConfig: {
      routerEnabled: boolean;
      autoIndex: boolean;
      tensorZeroEnabled: boolean;
      routerPolicy: string;
    },
  ): {
    routerEnabled: boolean;
    routerPolicy: string;
    autoIndex: boolean;
    tensorZeroEnabled: boolean;
  } {
    const policy = this.getEffectivePolicy(tenantId);
    return {
      routerEnabled: policy.router_required || (policy.router_enabled ?? globalConfig.routerEnabled),
      routerPolicy: policy.router_policy ?? globalConfig.routerPolicy,
      autoIndex: policy.auto_index_required || (policy.auto_index ?? globalConfig.autoIndex),
      tensorZeroEnabled: policy.tensorzero_enabled ?? globalConfig.tensorZeroEnabled,
    };
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private _hydrateRow(row: TenantPolicyRow): TenantComputePolicy {
    let allowedProviders: string[] = [];
    let computePools: ComputePoolRef[] = [];
    try {
      allowedProviders = JSON.parse(row.allowed_providers);
    } catch {
      logDebug("general", "default");
    }
    try {
      computePools = JSON.parse(row.compute_pools);
    } catch {
      logDebug("general", "default");
    }

    return {
      tenant_id: row.tenant_id,
      allowed_providers: allowedProviders,
      default_provider: row.default_provider,
      max_concurrent_sessions: row.max_concurrent_sessions,
      max_cost_per_day_usd: row.max_cost_per_day_usd ?? null,
      compute_pools: computePools,
      router_enabled: row.router_enabled == null ? null : !!row.router_enabled,
      router_required: !!row.router_required,
      router_policy: row.router_policy ?? null,
      auto_index: row.auto_index == null ? null : !!row.auto_index,
      auto_index_required: !!row.auto_index_required,
      tensorzero_enabled: row.tensorzero_enabled == null ? null : !!row.tensorzero_enabled,
    };
  }
}

interface TenantPolicyRow {
  tenant_id: string;
  allowed_providers: string;
  default_provider: string;
  max_concurrent_sessions: number;
  max_cost_per_day_usd: number | null;
  compute_pools: string;
  router_enabled: number | null;
  router_required: number | null;
  router_policy: string | null;
  auto_index: number | null;
  auto_index_required: number | null;
  tensorzero_enabled: number | null;
}
