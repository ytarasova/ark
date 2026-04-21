/**
 * ObservabilityClient -- costs, eval stats, dashboard, conductor, sage.
 *
 * Carries the agent-E block (conductor + sage + costs extended) -- see
 * markers below.
 */

import type { CostsReadResult } from "../../types/index.js";
import type { RpcFn } from "./rpc.js";

export class ObservabilityClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  // ── Costs ──────────────────────────────────────────────────────────────────

  async costsRead(): Promise<CostsReadResult> {
    return this.rpc<CostsReadResult>("costs/read");
  }

  async costsSummary(opts?: { groupBy?: string; tenantId?: string; since?: string; until?: string }): Promise<{
    summary: Array<{ key: string; cost: number; input_tokens: number; output_tokens: number; count: number }>;
    total: number;
  }> {
    return this.rpc("costs/summary", opts as Record<string, unknown>);
  }

  async costsTrend(opts?: { tenantId?: string; days?: number }): Promise<{
    trend: Array<{ date: string; cost: number }>;
  }> {
    return this.rpc("costs/trend", opts as Record<string, unknown>);
  }

  async costsSession(sessionId: string): Promise<{
    cost: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    total_tokens: number;
    records: Array<{
      id: number;
      session_id: string;
      tenant_id: string;
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
    }>;
  }> {
    return this.rpc("costs/session", { sessionId });
  }

  async costsRecord(opts: {
    sessionId: string;
    model: string;
    provider: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    tenantId?: string;
    runtime?: string;
    agentRole?: string;
    source?: string;
  }): Promise<{ ok: boolean }> {
    return this.rpc("costs/record", opts as Record<string, unknown>);
  }

  // ── Evals ──────────────────────────────────────────────────────────────────

  async evalStats(agentRole?: string): Promise<{
    stats: {
      totalSessions: number;
      completionRate: number;
      avgDurationMs: number;
      avgCost: number;
      avgTurns: number;
      testPassRate: number;
      prRate: number;
    };
  }> {
    return this.rpc("eval/stats", { agentRole });
  }

  async evalDrift(
    agentRole?: string,
    recentDays?: number,
  ): Promise<{ drift: { completionRateDelta: number; avgCostDelta: number; avgTurnsDelta: number; alert: boolean } }> {
    return this.rpc("eval/drift", { agentRole, recentDays });
  }

  async evalList(
    agentRole?: string,
    limit?: number,
  ): Promise<{
    evals: Array<{
      agentRole: string;
      runtime: string;
      model: string;
      sessionId: string;
      metrics: {
        completed: boolean;
        testsPassed: boolean | null;
        prCreated: boolean;
        turnCount: number;
        durationMs: number;
        tokenCost: number;
        filesChanged: number;
        retryCount: number;
      };
      timestamp: string;
    }>;
  }> {
    return this.rpc("eval/list", { agentRole, limit });
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────

  async dashboardSummary(): Promise<{
    counts: Record<string, number>;
    costs: { total: number; today: number; week: number; month: number; byModel: Record<string, number>; budget: any };
    recentEvents: Array<{
      sessionId: string;
      sessionSummary: string | null;
      type: string;
      data: any;
      created_at: string;
    }>;
    topCostSessions: Array<{ sessionId: string; summary: string | null; model: string | null; cost: number }>;
    system: { conductor: boolean; router: boolean };
    activeCompute: number;
  }> {
    return this.rpc("dashboard/summary");
  }

  // --- BEGIN agent-E: conductor + sage + costs extended ---

  async conductorStatus(): Promise<{ running: boolean; port: number; pid?: number }> {
    return this.rpc("conductor/status");
  }

  async conductorLearnings(): Promise<{
    learnings: Array<{
      id: string;
      title: string;
      description: string;
      recurrence: number;
      promoted: boolean;
      lastSeen: string;
    }>;
  }> {
    return this.rpc("conductor/learnings");
  }

  async conductorLearn(opts: { title: string; description?: string }): Promise<{
    ok: boolean;
    learning: {
      id: string;
      title: string;
      description: string;
      recurrence: number;
      promoted: boolean;
      lastSeen: string;
    };
  }> {
    return this.rpc("conductor/learn", opts as Record<string, unknown>);
  }

  async conductorBridge(): Promise<{ ok: boolean; running: boolean; message?: string }> {
    return this.rpc("conductor/bridge");
  }

  async conductorNotify(message: string): Promise<{ ok: boolean; message?: string }> {
    return this.rpc("conductor/notify", { message });
  }

  async sageContext(opts: { analysisId: string; sageUrl?: string }): Promise<{
    analysisId: string;
    baseUrl: string;
    summary: string | null;
    streamCount: number;
    taskCount: number;
    streams: Array<{ repo: string; branch: string | null; tasks: Array<{ title: string }> }>;
  }> {
    return this.rpc("sage/context", opts as Record<string, unknown>);
  }

  async sageAnalyze(opts: {
    analysisId: string;
    sageUrl?: string;
    compute?: string;
    runtime?: string;
    repo?: string;
  }): Promise<{
    ok: boolean;
    sessionId: string;
    analysisId: string;
    streamCount: number;
    taskCount: number;
    message?: string;
  }> {
    return this.rpc("sage/analyze", opts as Record<string, unknown>);
  }

  async costsSync(): Promise<{ ok: boolean; synced: number; skipped: number }> {
    return this.rpc("costs/sync");
  }

  async costsExport(opts?: { limit?: number }): Promise<{
    total: number;
    rows: Array<{
      sessionId: string;
      summary: string | null;
      model: string | null;
      cost: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
    }>;
  }> {
    return this.rpc("costs/export", (opts ?? {}) as Record<string, unknown>);
  }

  // --- END agent-E ---
}
