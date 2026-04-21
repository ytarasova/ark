/**
 * Tenant compute policies -- control what compute resources each tenant
 * can use, including allowed providers, concurrency limits, and cost caps.
 *
 * The control plane is the single authority that decides what compute a
 * tenant can use and provisions it. TenantPolicyManager persists policies
 * in SQLite and provides validation helpers used by the scheduler.
 */

import type { IDatabase } from "../database/index.js";
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
  allowed_k8s_contexts: string[]; // empty = all contexts allowed
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
  allowed_k8s_contexts: [],
};

// ── Manager ────────────────────────────────────────────────────────────────

export class TenantPolicyManager {
  private _initialized: Promise<void> | null = null;

  constructor(private db: IDatabase) {}

  /**
   * Lazily ensure the schema exists. Replaces the (now-async) constructor
   * work that used to init schema synchronously. Every public method awaits
   * this once before touching the table.
   */
  private async ensureSchema(): Promise<void> {
    if (this._initialized) return this._initialized;
    this._initialized = (async () => {
      await this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS tenant_policies (
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
          )`,
        )
        .run();
      await this._migrateIntegrationColumns();
    })();
    return this._initialized;
  }

  private async _migrateIntegrationColumns(): Promise<void> {
    const cols: [string, string][] = [
      ["router_enabled", "INTEGER"],
      ["router_required", "INTEGER NOT NULL DEFAULT 0"],
      ["router_policy", "TEXT"],
      ["auto_index", "INTEGER"],
      ["auto_index_required", "INTEGER NOT NULL DEFAULT 0"],
      ["tensorzero_enabled", "INTEGER"],
      ["allowed_k8s_contexts", "TEXT NOT NULL DEFAULT '[]'"],
      // Agent G -- cluster config YAML blob (see migration 008).
      ["compute_config_yaml", "TEXT"],
    ];
    for (const [col, def] of cols) {
      try {
        await this.db.prepare(`ALTER TABLE tenant_policies ADD COLUMN ${col} ${def}`).run();
      } catch {
        logInfo("general", "exists");
      }
    }
  }

  // ── Cluster / compute config blob (agent G) ───────────────────────────────
  //
  // A tenant admin can stash a YAML blob of cluster overrides on their
  // tenant_policies row. `resolveEffectiveClusters` merges that blob on top
  // of the system-layer `app.config.compute.clusters`. The blob is stored
  // verbatim; validation happens at set-time (via `parseClustersYaml`) to
  // surface malformed YAML before it hits dispatch.

  /** Fetch the tenant's compute-config YAML blob, or null if none. */
  async getComputeConfig(tenantId: string): Promise<string | null> {
    await this.ensureSchema();
    try {
      const row = (await this.db
        .prepare("SELECT compute_config_yaml FROM tenant_policies WHERE tenant_id = ?")
        .get(tenantId)) as { compute_config_yaml: string | null } | undefined;
      return row?.compute_config_yaml ?? null;
    } catch {
      // Column may not exist on a down-level DB. Return null so dispatch
      // falls back to system-layer clusters.
      return null;
    }
  }

  /**
   * Write the tenant's compute-config YAML blob. Creates a minimal
   * `tenant_policies` row when no explicit policy exists yet.
   *
   * Caller MUST have pre-validated the YAML via `parseClustersYaml` -- this
   * method stores the blob verbatim.
   */
  async setComputeConfig(tenantId: string, yaml: string): Promise<void> {
    await this.ensureSchema();
    const now = new Date().toISOString();
    const existing = await this.db.prepare("SELECT tenant_id FROM tenant_policies WHERE tenant_id = ?").get(tenantId);
    if (existing) {
      await this.db
        .prepare("UPDATE tenant_policies SET compute_config_yaml = ?, updated_at = ? WHERE tenant_id = ?")
        .run(yaml, now, tenantId);
    } else {
      await this.db
        .prepare(
          `INSERT INTO tenant_policies
             (tenant_id, allowed_providers, default_provider, max_concurrent_sessions, compute_pools,
              compute_config_yaml, created_at, updated_at)
           VALUES (?, '[]', 'k8s', 10, '[]', ?, ?, ?)`,
        )
        .run(tenantId, yaml, now, now);
    }
  }

  /** Clear the tenant's compute-config YAML blob. Returns true when a row was updated. */
  async clearComputeConfig(tenantId: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.db
      .prepare("UPDATE tenant_policies SET compute_config_yaml = NULL, updated_at = ? WHERE tenant_id = ?")
      .run(new Date().toISOString(), tenantId);
    return result.changes > 0;
  }

  /** Get the policy for a tenant, or null if no explicit policy exists. */
  async getPolicy(tenantId: string): Promise<TenantComputePolicy | null> {
    await this.ensureSchema();
    const row = (await this.db.prepare("SELECT * FROM tenant_policies WHERE tenant_id = ?").get(tenantId)) as
      | TenantPolicyRow
      | undefined;
    return row ? this._hydrateRow(row) : null;
  }

  /**
   * Get the effective policy for a tenant.
   * Returns the explicit policy if one exists, otherwise returns the default policy.
   */
  async getEffectivePolicy(tenantId: string): Promise<TenantComputePolicy> {
    return (await this.getPolicy(tenantId)) ?? { tenant_id: tenantId, ...DEFAULT_POLICY };
  }

  /** Set (create or update) a tenant policy. */
  async setPolicy(policy: TenantComputePolicy): Promise<void> {
    await this.ensureSchema();
    const now = new Date().toISOString();
    const providers = JSON.stringify(policy.allowed_providers);
    const pools = JSON.stringify(policy.compute_pools);
    const k8sContexts = JSON.stringify(policy.allowed_k8s_contexts ?? []);
    const routerEnabled = policy.router_enabled == null ? null : policy.router_enabled ? 1 : 0;
    const routerRequired = policy.router_required ? 1 : 0;
    const autoIndex = policy.auto_index == null ? null : policy.auto_index ? 1 : 0;
    const autoIndexRequired = policy.auto_index_required ? 1 : 0;
    const tensorzeroEnabled = policy.tensorzero_enabled == null ? null : policy.tensorzero_enabled ? 1 : 0;

    const existing = await this.db
      .prepare("SELECT tenant_id FROM tenant_policies WHERE tenant_id = ?")
      .get(policy.tenant_id);

    if (existing) {
      await this.db
        .prepare(
          `
        UPDATE tenant_policies
        SET allowed_providers = ?, default_provider = ?,
            max_concurrent_sessions = ?, max_cost_per_day_usd = ?,
            compute_pools = ?,
            router_enabled = ?, router_required = ?, router_policy = ?,
            auto_index = ?, auto_index_required = ?, tensorzero_enabled = ?,
            allowed_k8s_contexts = ?,
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
          k8sContexts,
          now,
          policy.tenant_id,
        );
    } else {
      await this.db
        .prepare(
          `
        INSERT INTO tenant_policies
          (tenant_id, allowed_providers, default_provider,
           max_concurrent_sessions, max_cost_per_day_usd, compute_pools,
           router_enabled, router_required, router_policy,
           auto_index, auto_index_required, tensorzero_enabled,
           allowed_k8s_contexts,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          k8sContexts,
          now,
          now,
        );
    }
  }

  /** Delete a tenant policy. Returns true if a policy was deleted. */
  async deletePolicy(tenantId: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.db.prepare("DELETE FROM tenant_policies WHERE tenant_id = ?").run(tenantId);
    return result.changes > 0;
  }

  /** List all tenant policies. */
  async listPolicies(): Promise<TenantComputePolicy[]> {
    await this.ensureSchema();
    const rows = (await this.db.prepare("SELECT * FROM tenant_policies ORDER BY tenant_id").all()) as TenantPolicyRow[];
    return rows.map((r) => this._hydrateRow(r));
  }

  // ── Validation helpers ──────────────────────────────────────────────────

  /**
   * Check if a provider is allowed for a tenant.
   * An empty allowed_providers list means all providers are allowed.
   */
  async isProviderAllowed(tenantId: string, provider: string): Promise<boolean> {
    const policy = await this.getEffectivePolicy(tenantId);
    if (policy.allowed_providers.length === 0) return true;
    return policy.allowed_providers.includes(provider);
  }

  /**
   * Check if a k8s kubeconfig context is allowed for a tenant.
   * An empty allowed_k8s_contexts list means all contexts are allowed --
   * use this to lock a tenant to specific clusters.
   */
  async isK8sContextAllowed(tenantId: string, context: string): Promise<boolean> {
    const policy = await this.getEffectivePolicy(tenantId);
    if (!policy.allowed_k8s_contexts || policy.allowed_k8s_contexts.length === 0) return true;
    return policy.allowed_k8s_contexts.includes(context);
  }

  /**
   * Get the number of active (running) sessions for a tenant.
   * Queries the sessions table via the shared database connection.
   */
  async getActiveSessions(tenantId: string): Promise<number> {
    try {
      const row = (await this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM sessions
         WHERE status = 'running' AND tenant_id = ?`,
        )
        .get(tenantId)) as { cnt: number } | undefined;
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
  async canDispatch(tenantId: string): Promise<{ allowed: boolean; reason?: string }> {
    const policy = await this.getEffectivePolicy(tenantId);
    const active = await this.getActiveSessions(tenantId);

    if (active >= policy.max_concurrent_sessions) {
      return {
        allowed: false,
        reason: `Tenant "${tenantId}" has reached the maximum concurrent sessions limit (${policy.max_concurrent_sessions}). Active: ${active}.`,
      };
    }

    return { allowed: true };
  }

  /** Get effective integration settings: tenant policy -> global config fallback. */
  async getEffectiveIntegrationSettings(
    tenantId: string,
    globalConfig: {
      routerEnabled: boolean;
      autoIndex: boolean;
      tensorZeroEnabled: boolean;
      routerPolicy: string;
    },
  ): Promise<{
    routerEnabled: boolean;
    routerPolicy: string;
    autoIndex: boolean;
    tensorZeroEnabled: boolean;
  }> {
    const policy = await this.getEffectivePolicy(tenantId);
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
    let k8sContexts: string[] = [];
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
    try {
      if (row.allowed_k8s_contexts) k8sContexts = JSON.parse(row.allowed_k8s_contexts);
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
      allowed_k8s_contexts: k8sContexts,
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
  allowed_k8s_contexts: string | null;
}
