import { useEffect, useRef, useState } from "react";
import { api } from "../hooks/useApi.js";
import { useSmartPoll } from "../hooks/useSmartPoll.js";
import { fmtCost, relTime } from "../util.js";
import { cn } from "../lib/utils.js";
import { AlertCircle, CheckCircle2, Clock, RotateCcw, Eye } from "lucide-react";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

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
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = () => {
    api
      .getDashboardSummary()
      .then((d) => {
        if (mountedRef.current) setData(d);
      })
      .catch((e: any) => {
        if (mountedRef.current) setError(e.message);
      });
    api
      .getSessions({})
      .then((s) => {
        if (mountedRef.current) setSessions(s);
      })
      .catch(() => {});
  };

  useEffect(() => {
    load();
  }, []);
  useSmartPoll(load, 5000);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Failed to load dashboard: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading dashboard...</div>
    );
  }

  const { costs } = data;

  const waitingSessions = sessions.filter((s) => s.status === "waiting" || s.status === "blocked");
  const failedSessions = sessions.filter((s) => s.status === "failed");
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
