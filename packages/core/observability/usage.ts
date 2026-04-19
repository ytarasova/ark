/**
 * UsageRecorder -- persistent token/cost recording with multi-dimensional attribution.
 *
 * Records usage events from any source (transcript parsing, router, API, manual)
 * into the `usage_records` table. Provides grouped summaries and daily trends.
 */

import type { IDatabase } from "../database/index.js";
import type { PricingRegistry, TokenUsage } from "./pricing.js";

export interface UsageRecord {
  id: number;
  session_id: string;
  tenant_id: string;
  user_id: string;
  model: string;
  provider: string;
  runtime: string | null;
  agent_role: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  source: string;
  created_at: string;
}

export type CostMode = "api" | "subscription" | "free";

export interface RecordOpts {
  sessionId: string;
  tenantId?: string;
  userId?: string;
  model: string;
  provider: string;
  runtime?: string;
  agentRole?: string;
  usage: TokenUsage;
  source?: string;
  /** Billing mode: 'api' (per-token), 'subscription' (flat rate, cost_usd=0), 'free' (no cost). */
  costMode?: CostMode;
}

export interface UsageSummaryRow {
  key: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  count: number;
}

export interface DailyTrendRow {
  date: string;
  cost: number;
}

const VALID_GROUP_COLS = new Set(["model", "provider", "runtime", "agent_role", "session_id", "tenant_id", "user_id"]);

export class UsageRecorder {
  private tenantId: string = "default";

  constructor(
    private db: IDatabase,
    private pricing: PricingRegistry,
  ) {}

  setTenant(id: string): void {
    this.tenantId = id;
  }
  getTenant(): string {
    return this.tenantId;
  }

  /**
   * Record a usage event. Called by executors, router, or transcript parser.
   *
   * Tenant scoping: the recorder's configured tenant is authoritative.
   * A caller-supplied `opts.tenantId` is accepted only when it matches the
   * scoped tenant, otherwise the scoped tenant is used. This prevents a
   * remote RPC (`costs/record`) from writing rows attributed to other tenants.
   */
  record(opts: RecordOpts): void {
    const costMode = opts.costMode ?? "api";
    // Subscription and free modes record zero cost (tokens still tracked for productivity/rate limits)
    const cost = costMode === "api" ? this.pricing.calculateCost(opts.model, opts.usage) : 0;
    const tenantId = opts.tenantId && opts.tenantId === this.tenantId ? opts.tenantId : this.tenantId;
    this.db
      .prepare(
        `
      INSERT INTO usage_records (session_id, tenant_id, user_id, model, provider, runtime, agent_role,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_mode, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        opts.sessionId,
        tenantId,
        opts.userId ?? "system",
        opts.model,
        opts.provider,
        opts.runtime ?? null,
        opts.agentRole ?? null,
        opts.usage.input_tokens,
        opts.usage.output_tokens,
        opts.usage.cache_read_tokens ?? 0,
        opts.usage.cache_write_tokens ?? 0,
        cost,
        costMode,
        opts.source ?? "api",
      );
  }

  /**
   * Get total cost, aggregated token totals, and all records for a session.
   *
   * Tenant scoping: always filtered by the recorder's configured tenant to
   * prevent cross-tenant cost disclosure. A caller in tenant A cannot read
   * tenant B's usage by guessing a session id.
   */
  getSessionCost(sessionId: string): {
    cost: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    total_tokens: number;
    records: UsageRecord[];
  } {
    const records = this.db
      .prepare("SELECT * FROM usage_records WHERE session_id = ? AND tenant_id = ? ORDER BY created_at")
      .all(sessionId, this.tenantId) as UsageRecord[];
    let cost = 0,
      input = 0,
      output = 0,
      cacheR = 0,
      cacheW = 0;
    for (const r of records) {
      cost += r.cost_usd;
      input += r.input_tokens;
      output += r.output_tokens;
      cacheR += r.cache_read_tokens;
      cacheW += r.cache_write_tokens;
    }
    return {
      cost,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheR,
      cache_write_tokens: cacheW,
      total_tokens: input + output,
      records,
    };
  }

  /**
   * Get cost summary with multi-dimensional grouping.
   *
   * Tenant scoping: always filtered by `opts.tenantId` when provided AND it
   * matches the recorder's configured tenant, or by the recorder's tenant
   * otherwise. A caller cannot pass an arbitrary tenantId to see another
   * tenant's data -- mismatches are ignored in favor of the scoped tenant.
   */
  getSummary(opts?: { tenantId?: string; since?: string; until?: string; groupBy?: string }): UsageSummaryRow[] {
    const groupCol = opts?.groupBy ?? "model";
    // Validate column name to prevent SQL injection
    if (!VALID_GROUP_COLS.has(groupCol)) {
      throw new Error(`Invalid groupBy column: ${groupCol}`);
    }

    const conditions: string[] = ["tenant_id = ?"];
    const params: any[] = [this.tenantId];

    if (opts?.since) {
      conditions.push("created_at >= ?");
      params.push(opts.since);
    }
    if (opts?.until) {
      conditions.push("created_at <= ?");
      params.push(opts.until);
    }

    const sql = `SELECT ${groupCol} as key, SUM(cost_usd) as cost,
                 SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
                 COUNT(*) as count FROM usage_records
                 WHERE ${conditions.join(" AND ")}
                 GROUP BY ${groupCol} ORDER BY cost DESC`;

    return this.db.prepare(sql).all(...params) as UsageSummaryRow[];
  }

  /**
   * Get daily cost trend.
   *
   * Tenant scoping: always filtered by the recorder's configured tenant.
   * A caller-supplied `opts.tenantId` that does not match is ignored.
   */
  getDailyTrend(opts?: { tenantId?: string; days?: number }): DailyTrendRow[] {
    const days = opts?.days ?? 30;
    // Clamp to a sane positive range so an attacker can't pass arbitrary
    // text through string interpolation. (The datetime modifier is not
    // parameterizable in SQLite, so we coerce and clamp to integer first.)
    const safeDays = Math.max(1, Math.min(3650, Math.floor(Number(days) || 30)));
    const conditions: string[] = [`created_at >= datetime('now', '-${safeDays} days')`, "tenant_id = ?"];
    const params: any[] = [this.tenantId];

    const sql = `SELECT DATE(created_at) as date, SUM(cost_usd) as cost
                 FROM usage_records
                 WHERE ${conditions.join(" AND ")}
                 GROUP BY DATE(created_at) ORDER BY date`;

    return this.db.prepare(sql).all(...params) as DailyTrendRow[];
  }

  /**
   * Get total cost across all records matching optional filters.
   *
   * Tenant scoping: always filtered by the recorder's configured tenant --
   * a caller-supplied `opts.tenantId` cannot override the scoped tenant.
   */
  getTotalCost(opts?: { tenantId?: string; since?: string; until?: string }): number {
    const conditions: string[] = ["tenant_id = ?"];
    const params: any[] = [this.tenantId];
    if (opts?.since) {
      conditions.push("created_at >= ?");
      params.push(opts.since);
    }
    if (opts?.until) {
      conditions.push("created_at <= ?");
      params.push(opts.until);
    }

    const sql = `SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_records WHERE ${conditions.join(" AND ")}`;
    const row = this.db.prepare(sql).get(...params) as { total: number } | undefined;
    return row?.total ?? 0;
  }
}
