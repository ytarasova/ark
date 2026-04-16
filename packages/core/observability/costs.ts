/**
 * Cost calculation and backfill helpers.
 *
 * Delegates pricing to PricingRegistry for 300+ model support. The canonical
 * source of per-session cost is the usage_records table written by
 * UsageRecorder during session completion; these functions operate on that
 * data for display and export.
 */

import type { TokenUsage } from "./pricing.js";
import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";
import { PricingRegistry } from "./pricing.js";
import { syncBurn } from "./burn/sync.js";

// Shared registry instance for standalone function calls
const _registry = new PricingRegistry();

const DEFAULT_MODEL = "sonnet";

/** Calculate cost in USD from token usage and model name. */
export function calculateCost(usage: TokenUsage, model?: string | null): number {
  const m = model ?? DEFAULT_MODEL;
  const resolved = _registry.getPrice(m) ? m : DEFAULT_MODEL;
  return _registry.calculateCost(resolved, usage);
}

/** Format cost as string: "$1.23" or "<$0.01" */
export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0) return `-$${Math.abs(cost).toFixed(2)}`;
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

export interface SessionCostSummary {
  sessionId: string;
  summary: string | null;
  model: string | null;
  usage: TokenUsage | null;
  cost: number;
}

/** Get cost info for a single session from UsageRecorder. */
export function getSessionCost(app: AppContext, session: Session): SessionCostSummary {
  const agg = app.usageRecorder.getSessionCost(session.id);
  const first = agg.records[0];
  const usage: TokenUsage | null = first
    ? {
        input_tokens: agg.input_tokens,
        output_tokens: agg.output_tokens,
        cache_read_tokens: agg.cache_read_tokens,
        cache_write_tokens: agg.cache_write_tokens,
      }
    : null;
  return {
    sessionId: session.id,
    summary: session.summary,
    model: first?.model ?? session.agent ?? null,
    usage,
    cost: agg.cost,
  };
}

/** Get costs for all sessions, sorted by cost descending. */
export function getAllSessionCosts(
  app: AppContext,
  sessions: Session[],
): { sessions: SessionCostSummary[]; total: number } {
  const costs = sessions
    .map((s) => getSessionCost(app, s))
    .filter((c) => c.cost > 0 || (c.usage?.input_tokens ?? 0) > 0);
  costs.sort((a, b) => b.cost - a.cost);
  const total = costs.reduce((sum, c) => sum + c.cost, 0);
  return { sessions: costs, total };
}

export interface BudgetConfig {
  dailyLimit?: number;
  weeklyLimit?: number;
  monthlyLimit?: number;
}

export interface BudgetStatus {
  daily: { spent: number; limit: number | null; pct: number; warning: boolean; exceeded: boolean };
  weekly: { spent: number; limit: number | null; pct: number; warning: boolean; exceeded: boolean };
  monthly: { spent: number; limit: number | null; pct: number; warning: boolean; exceeded: boolean };
}

/** Check budget status against configured limits. */
export function checkBudget(app: AppContext, sessions: Session[], budgets: BudgetConfig): BudgetStatus {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(now.getTime() - now.getDay() * 86400000);
  weekStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const dailySessions = sessions.filter((s) => s.updated_at >= todayStart);
  const weeklySessions = sessions.filter((s) => s.updated_at >= weekStart.toISOString());
  const monthlySessions = sessions.filter((s) => s.updated_at >= monthStart);

  const dailySpent = getAllSessionCosts(app, dailySessions).total;
  const weeklySpent = getAllSessionCosts(app, weeklySessions).total;
  const monthlySpent = getAllSessionCosts(app, monthlySessions).total;

  function bucket(spent: number, limit: number | undefined | null) {
    const lim = limit ?? null;
    const pct = lim ? (spent / lim) * 100 : 0;
    return { spent, limit: lim, pct, warning: pct >= 80, exceeded: pct >= 100 };
  }

  return {
    daily: bucket(dailySpent, budgets.dailyLimit),
    weekly: bucket(weeklySpent, budgets.weeklyLimit),
    monthly: bucket(monthlySpent, budgets.monthlyLimit),
  };
}

/**
 * Backfill usage_records from on-disk transcripts for sessions that don't
 * have cost data yet. Uses the polymorphic TranscriptParserRegistry so it
 * works across all runtimes (Claude, Codex, Gemini, ...).
 */
export function syncCosts(app: AppContext): { synced: number; skipped: number } {
  const sessions = app.sessions.list({ limit: 1000 });
  let synced = 0;
  let skipped = 0;

  for (const session of sessions) {
    // Skip sessions that already have recorded usage
    if (app.usageRecorder.getSessionCost(session.id).records.length > 0) {
      skipped++;
      continue;
    }
    if (!session.workdir) {
      skipped++;
      continue;
    }

    // Resolve the runtime + parser
    const runtimeName = (session.config?.runtime as string | undefined) ?? session.agent ?? "claude";
    const runtime = app.runtimes.get(runtimeName);
    const kind = runtime?.billing?.transcript_parser ?? "claude";
    const parser = app.transcriptParsers.get(kind);
    if (!parser) {
      skipped++;
      continue;
    }

    const transcriptPath = parser.findForSession({
      workdir: session.workdir,
      startTime: session.created_at ? new Date(session.created_at) : undefined,
    });
    if (!transcriptPath) {
      skipped++;
      continue;
    }

    const { usage, model } = parser.parse(transcriptPath);
    if (usage.input_tokens === 0 && usage.output_tokens === 0) {
      skipped++;
      continue;
    }

    const provider =
      kind === "claude" ? "anthropic" : kind === "codex" ? "openai" : kind === "gemini" ? "google" : kind;
    app.usageRecorder.record({
      sessionId: session.id,
      model: model ?? (session.config?.model as string) ?? "unknown",
      provider,
      runtime: runtimeName,
      agentRole: session.agent ?? undefined,
      usage,
      source: "backfill",
      costMode: runtime?.billing?.mode ?? "api",
    });
    synced++;
  }

  // Also sync burn data from transcripts
  try {
    syncBurn(app);
  } catch (err) {
    console.warn("[burn] sync failed:", err);
  }

  return { synced, skipped };
}

/** Export cost data as CSV string. */
export function exportCostsCsv(app: AppContext, sessions: Session[]): string {
  const costs = getAllSessionCosts(app, sessions);
  const lines = ["session_id,summary,model,cost_usd,input_tokens,output_tokens,cache_read,cache_write,total_tokens"];
  for (const c of costs.sessions) {
    const u = c.usage;
    const total = u ? u.input_tokens + u.output_tokens + (u.cache_read_tokens ?? 0) + (u.cache_write_tokens ?? 0) : 0;
    lines.push(
      [
        c.sessionId,
        `"${(c.summary ?? "").replace(/"/g, '""')}"`,
        c.model ?? "",
        c.cost.toFixed(4),
        u?.input_tokens ?? 0,
        u?.output_tokens ?? 0,
        u?.cache_read_tokens ?? 0,
        u?.cache_write_tokens ?? 0,
        total,
      ].join(","),
    );
  }
  return lines.join("\n");
}
