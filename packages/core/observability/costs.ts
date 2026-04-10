/**
 * Cost calculation from token usage.
 *
 * Delegates pricing to PricingRegistry for 300+ model support.
 * Maintains backward-compatible API for existing callers.
 */

import type { TranscriptUsage } from "../claude/claude.js";
import { parseTranscriptUsage } from "../claude/claude.js";
import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";
import { PricingRegistry } from "./pricing.js";

import { readdirSync, existsSync } from "fs";
import { join } from "path";

// Shared registry instance for standalone function calls
const _registry = new PricingRegistry();

const DEFAULT_MODEL = "sonnet";

/** Calculate cost in USD from token usage and model name. */
export function calculateCost(usage: TranscriptUsage, model?: string | null): number {
  const m = model ?? DEFAULT_MODEL;
  const tokenUsage = {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_input_tokens,
    cache_write_tokens: usage.cache_creation_input_tokens,
  };
  // Fall back to sonnet pricing for unrecognized model names (backward compat)
  const resolved = _registry.getPrice(m) ? m : DEFAULT_MODEL;
  return _registry.calculateCost(resolved, tokenUsage);
}

/** Format cost as string: "$1.23" or "<$0.01" */
export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0) return `-$${Math.abs(cost).toFixed(2)}`;
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

export interface SessionCost {
  sessionId: string;
  summary: string | null;
  model: string | null;
  usage: TranscriptUsage | null;
  cost: number;
}

/** Get cost info for a single session. */
export function getSessionCost(session: Session): SessionCost {
  const usage = session.config?.usage as TranscriptUsage | null ?? null;
  const model = (session.config?.model as string) ?? session.agent ?? null;
  const cost = usage ? calculateCost(usage, model) : 0;
  return {
    sessionId: session.id,
    summary: session.summary,
    model,
    usage,
    cost,
  };
}

/** Get costs for all sessions, sorted by cost descending. */
export function getAllSessionCosts(sessions: Session[]): { sessions: SessionCost[]; total: number } {
  const costs = sessions.map(getSessionCost).filter(c => c.cost > 0);
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
export function checkBudget(sessions: Session[], budgets: BudgetConfig): BudgetStatus {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(now.getTime() - now.getDay() * 86400000);
  weekStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const dailySessions = sessions.filter(s => s.updated_at >= todayStart);
  const weeklySessions = sessions.filter(s => s.updated_at >= weekStart.toISOString());
  const monthlySessions = sessions.filter(s => s.updated_at >= monthStart);

  const dailySpent = getAllSessionCosts(dailySessions).total;
  const weeklySpent = getAllSessionCosts(weeklySessions).total;
  const monthlySpent = getAllSessionCosts(monthlySessions).total;

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

/** Sync cost data from Claude transcripts into session configs. */
export function syncCosts(app: AppContext): { synced: number; skipped: number } {
  const sessions = app.sessions.list({ limit: 1000 });
  let synced = 0;
  let skipped = 0;

  const claudeDir = join(process.env.HOME ?? "~", ".claude", "projects");
  if (!existsSync(claudeDir)) return { synced: 0, skipped: 0 };

  for (const session of sessions) {
    // Skip sessions that already have usage data
    if ((session.config?.usage?.total_tokens ?? 0) > 0) { skipped++; continue; }

    // Try to find transcript by claude_session_id
    if (!session.claude_session_id) { skipped++; continue; }

    // Search for the transcript file
    try {
      const projects = readdirSync(claudeDir);
      for (const project of projects) {
        const projectDir = join(claudeDir, project);
        try {
          const files = readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
          for (const file of files) {
            if (file.includes(session.claude_session_id!)) {
              const transcriptPath = join(projectDir, file);
              const usage = parseTranscriptUsage(transcriptPath);
              if (usage.total_tokens > 0) {
                app.sessions.update(session.id, { config: { ...session.config, usage } });
                synced++;
              }
              break;
            }
          }
        } catch { continue; }
      }
    } catch { skipped++; }
  }

  return { synced, skipped };
}

/** Export cost data as CSV string. */
export function exportCostsCsv(sessions: Session[]): string {
  const costs = getAllSessionCosts(sessions);
  const lines = ["session_id,summary,model,cost_usd,input_tokens,output_tokens,cache_read,cache_write,total_tokens"];
  for (const c of costs.sessions) {
    const u = c.usage;
    lines.push([
      c.sessionId,
      `"${(c.summary ?? "").replace(/"/g, '""')}"`,
      c.model ?? "",
      c.cost.toFixed(4),
      u?.input_tokens ?? 0,
      u?.output_tokens ?? 0,
      u?.cache_read_input_tokens ?? 0,
      u?.cache_creation_input_tokens ?? 0,
      u?.total_tokens ?? 0,
    ].join(","));
  }
  return lines.join("\n");
}
