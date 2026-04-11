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

  constructor(private db: IDatabase, private pricing: PricingRegistry) {}

  setTenant(id: string): void { this.tenantId = id; }
  getTenant(): string { return this.tenantId; }

  /** Record a usage event. Called by executors, router, or transcript parser. */
  record(opts: RecordOpts): void {
    const costMode = opts.costMode ?? "api";
    // Subscription and free modes record zero cost (tokens still tracked for productivity/rate limits)
    const cost = costMode === "api" ? this.pricing.calculateCost(opts.model, opts.usage) : 0;
    this.db.prepare(`
      INSERT INTO usage_records (session_id, tenant_id, user_id, model, provider, runtime, agent_role,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_mode, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.sessionId,
      opts.tenantId ?? this.tenantId,
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

  /** Get total cost and all records for a session. */
  getSessionCost(sessionId: string): { cost: number; records: UsageRecord[] } {
    const records = this.db.prepare(
      "SELECT * FROM usage_records WHERE session_id = ? ORDER BY created_at",
    ).all(sessionId) as UsageRecord[];
    const cost = records.reduce((s, r) => s + r.cost_usd, 0);
    return { cost, records };
  }

  /** Get cost summary with multi-dimensional grouping. */
  getSummary(opts?: {
    tenantId?: string;
    since?: string;
    until?: string;
    groupBy?: string;
  }): UsageSummaryRow[] {
    const groupCol = opts?.groupBy ?? "model";
    // Validate column name to prevent SQL injection
    if (!VALID_GROUP_COLS.has(groupCol)) {
      throw new Error(`Invalid groupBy column: ${groupCol}`);
    }

    const conditions: string[] = ["1=1"];
    const params: any[] = [];

    if (opts?.tenantId) {
      conditions.push("tenant_id = ?");
      params.push(opts.tenantId);
    }
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

  /** Get daily cost trend. */
  getDailyTrend(opts?: { tenantId?: string; days?: number }): DailyTrendRow[] {
    const days = opts?.days ?? 30;
    const conditions: string[] = [`created_at >= datetime('now', '-${days} days')`];
    const params: any[] = [];

    if (opts?.tenantId) {
      conditions.push("tenant_id = ?");
      params.push(opts.tenantId);
    }

    const sql = `SELECT DATE(created_at) as date, SUM(cost_usd) as cost
                 FROM usage_records
                 WHERE ${conditions.join(" AND ")}
                 GROUP BY DATE(created_at) ORDER BY date`;

    return this.db.prepare(sql).all(...params) as DailyTrendRow[];
  }

  /** Get total cost across all records matching optional filters. */
  getTotalCost(opts?: { tenantId?: string; since?: string; until?: string }): number {
    const conditions: string[] = ["1=1"];
    const params: any[] = [];
    if (opts?.tenantId) { conditions.push("tenant_id = ?"); params.push(opts.tenantId); }
    if (opts?.since) { conditions.push("created_at >= ?"); params.push(opts.since); }
    if (opts?.until) { conditions.push("created_at <= ?"); params.push(opts.until); }

    const sql = `SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_records WHERE ${conditions.join(" AND ")}`;
    const row = this.db.prepare(sql).get(...params) as { total: number } | undefined;
    return row?.total ?? 0;
  }
}
