import { fmtCost, relTime } from "../util.js";
import { cn } from "../lib/utils.js";
import { AlertCircle, CheckCircle2, Clock, RotateCcw, Eye } from "lucide-react";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";
import { useDashboardSummaryQuery, useRunningSessionsQuery } from "../hooks/useDashboardQuery.js";

interface DashboardData {
  counts: Record<string, number>;
  costs: {
    total: number;
    today: number;
    week: number;
    month: number;
    byModel: Record<string, number>;
    budget: any;
  };
  recentEvents: Array<{
    sessionId: string;
    sessionSummary: string | null;
    type: string;
    data: any;
    created_at: string;
  }>;
  topCostSessions: Array<{
    sessionId: string;
    summary: string | null;
    model: string | null;
    cost: number;
  }>;
  system: { conductor: boolean; router: boolean };
  activeCompute: number;
}

interface DashboardViewProps {
  onNavigate: (view: string) => void;
  onSelectSession?: (sessionId: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
}

export function DashboardView({
  onNavigate: _onNavigate,
  onSelectSession,
  readOnly: _readOnly,
  daemonStatus: _daemonStatus,
}: DashboardViewProps) {
  const summaryQuery = useDashboardSummaryQuery();
  const sessionsQuery = useRunningSessionsQuery();
  const data = summaryQuery.data as DashboardData | undefined;
  const sessions = sessionsQuery.data ?? [];

  if (summaryQuery.isError) {
    const err: any = summaryQuery.error;
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="max-w-md text-center">
          <AlertCircle size={24} className="text-[var(--failed)] mx-auto mb-3 opacity-80" />
          <p className="text-sm font-medium text-foreground mb-1">Couldn't load the dashboard</p>
          <p className="text-[12px] text-muted-foreground">{err?.message ?? "Unknown error"}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    // Skeleton matches the real dashboard's top-row shape (4 stat cards +
    // a wide panel) so the layout doesn't jump when data arrives. Plain
    // text on an empty viewport was the worst possible placeholder.
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-secondary/30 h-24 animate-pulse"
              aria-hidden="true"
            />
          ))}
        </div>
        <div className="rounded-lg border border-border bg-secondary/30 h-64 animate-pulse" aria-hidden="true" />
        <div className="rounded-lg border border-border bg-secondary/30 h-40 animate-pulse" aria-hidden="true" />
        <span className="sr-only">Loading dashboard</span>
      </div>
    );
  }

  const { costs } = data;

  const waitingSessions = sessions.filter((s: any) => s.status === "waiting" || s.status === "blocked");
  const failedSessions = sessions.filter((s: any) => s.status === "failed");
  const needsAttention = waitingSessions.length > 0 || failedSessions.length > 0;

  const budget = costs.budget?.daily?.limit
    ? costs.budget.daily
    : costs.budget?.weekly?.limit
      ? costs.budget.weekly
      : costs.budget?.monthly?.limit
        ? costs.budget.monthly
        : null;
  const hasBudgetWarning = budget && (budget.warning || budget.exceeded);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="w-full px-6 py-8 flex flex-col gap-6">
        {/* Budget warning */}
        {hasBudgetWarning && budget && (
          <div
            className={cn(
              "rounded-lg border px-4 py-3",
              budget.exceeded
                ? "border-[var(--failed)]/30 bg-[var(--failed)]/5"
                : "border-[var(--waiting)]/30 bg-[var(--waiting)]/5",
            )}
          >
            <div className="flex items-center justify-between mb-2">
              <span
                className={cn(
                  "text-[12px] font-medium",
                  budget.exceeded ? "text-[var(--failed)]" : "text-[var(--waiting)]",
                )}
              >
                {budget.exceeded ? "Budget exceeded" : "Budget warning"}
              </span>
              <span className="text-[11px] font-mono text-muted-foreground">
                {fmtCost(budget.spent)} / {fmtCost(budget.limit)}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  budget.exceeded ? "bg-[var(--failed)]" : "bg-[var(--waiting)]",
                )}
                style={{ width: Math.min(100, budget.pct) + "%" }}
              />
            </div>
          </div>
        )}

        {/* All clear */}
        {!needsAttention && !hasBudgetWarning && (
          <div className="flex items-center justify-center py-12">
            <div className="flex items-center gap-2.5 text-[14px] text-muted-foreground">
              <CheckCircle2 size={18} className="text-[var(--running)] opacity-70" />
              All clear -- no sessions need your attention
            </div>
          </div>
        )}

        {/* Waiting sessions */}
        {waitingSessions.length > 0 && (
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--waiting)] mb-2 flex items-center gap-1.5">
              <Clock size={12} />
              Waiting for input ({waitingSessions.length})
            </h3>
            <div className="border border-border rounded-lg divide-y divide-border/50 overflow-hidden">
              {waitingSessions.slice(0, 10).map((s) => (
                <div
                  key={s.session_id || s.id}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-accent transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-foreground truncate">{s.summary || s.session_id || s.id}</div>
                    <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                      {s.agent || "agent"} -- {s.stage || "running"}
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0 ml-3">
                    <button
                      type="button"
                      onClick={() => onSelectSession?.(s.session_id || s.id)}
                      aria-label="Review waiting session"
                      className={cn(
                        "h-6 px-2 rounded text-[10px] font-medium",
                        "border border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]",
                        "hover:opacity-90 transition-opacity cursor-pointer",
                        "flex items-center gap-1",
                      )}
                    >
                      <Eye size={10} /> Review
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Failed sessions */}
        {failedSessions.length > 0 && (
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--failed)] mb-2 flex items-center gap-1.5">
              <AlertCircle size={12} />
              Failed ({failedSessions.length})
            </h3>
            <div className="overflow-hidden">
              {failedSessions.slice(0, 10).map((s) => (
                <div
                  key={s.session_id || s.id}
                  className="flex items-center gap-3 px-3 py-2 border-l-2 border-l-[var(--failed)] border-b border-b-[var(--border)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-foreground truncate">{s.summary || s.session_id || s.id}</div>
                    {(s.error || s.stage) && (
                      <div className="text-[11px] text-muted-foreground truncate mt-0.5">{s.error || s.stage}</div>
                    )}
                  </div>
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                    {relTime(s.updated_at || s.created_at)}
                  </span>
                  <div className="flex gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => onSelectSession?.(s.session_id || s.id)}
                      aria-label="View failed session"
                      className={cn(
                        "h-5 px-1.5 rounded text-[10px] font-medium",
                        "border border-border bg-transparent text-foreground",
                        "hover:bg-accent transition-colors cursor-pointer",
                        "flex items-center gap-0.5",
                      )}
                    >
                      <Eye size={9} /> View
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectSession?.(s.session_id || s.id)}
                      aria-label="Restart failed session"
                      className={cn(
                        "h-5 px-1.5 rounded text-[10px] font-medium",
                        "border border-[var(--running)] bg-transparent text-[var(--running)]",
                        "hover:bg-[var(--diff-add-bg)] transition-colors cursor-pointer",
                        "flex items-center gap-0.5",
                      )}
                    >
                      <RotateCcw size={9} /> Restart
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
