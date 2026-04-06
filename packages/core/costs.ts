/**
 * Cost calculation from token usage.
 * Pricing per million tokens (as of 2025-05).
 */

import type { TranscriptUsage } from "./claude.js";
import { parseTranscriptUsage } from "./claude.js";
import type { Session } from "../types/index.js";
import { getApp } from "./app.js";
import { listSessions as storeListSessions, updateSession as storeUpdateSession } from "./store.js";
import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";

// Pricing per million tokens
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "opus":   { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  "sonnet": { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75 },
  "haiku":  { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00 },
};

const DEFAULT_MODEL = "sonnet";

/** Calculate cost in USD from token usage and model name. */
export function calculateCost(usage: TranscriptUsage, model?: string | null): number {
  const p = PRICING[model ?? DEFAULT_MODEL] ?? PRICING[DEFAULT_MODEL];
  return (
    (usage.input_tokens * p.input / 1_000_000) +
    (usage.output_tokens * p.output / 1_000_000) +
    (usage.cache_read_input_tokens * p.cacheRead / 1_000_000) +
    (usage.cache_creation_input_tokens * p.cacheWrite / 1_000_000)
  );
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
  const usage = (session.config?.usage as TranscriptUsage) ?? null;
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
export function syncCosts(): { synced: number; skipped: number } {
  let sessions;
  try { sessions = getApp().sessions.list({ limit: 1000 }); }
  catch { sessions = storeListSessions({ limit: 1000 }) as Session[]; }
  let synced = 0;
  let skipped = 0;

  const claudeDir = join(process.env.HOME ?? "~", ".claude", "projects");
  if (!existsSync(claudeDir)) return { synced: 0, skipped: 0 };

  for (const session of sessions) {
    // Skip sessions that already have usage data
    if ((session.config as any)?.usage?.total_tokens > 0) { skipped++; continue; }

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
                try { getApp().sessions.update(session.id, { config: { ...session.config, usage } }); }
                catch { storeUpdateSession(session.id, { config: { ...session.config, usage } }); }
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
