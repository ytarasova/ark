import { useEffect, useRef, useState } from "react";
import { api } from "../hooks/useApi.js";
import { useSmartPoll } from "../hooks/useSmartPoll.js";
import { fmtCost } from "../util.js";
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
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
}

function formatEventType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function DashboardView({ onNavigate, readOnly: _readOnly, daemonStatus }: DashboardViewProps) {
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

  const { counts, costs, recentEvents, system } = data;

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

  const conductorOnline = daemonStatus ? daemonStatus.conductor.online : system.conductor;
  const arkdOnline = daemonStatus?.arkd.online ?? false;
  const routerStatus = system.router;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="max-w-[720px] w-full mx-auto px-6 py-8 flex flex-col gap-6">
        {/* System health status line */}
        <div className="flex items-center gap-4 text-[12px] text-muted-foreground font-[family-name:var(--font-mono)]">
          <span className="flex items-center gap-1.5">
            <span
              className={cn("w-1.5 h-1.5 rounded-full", conductorOnline ? "bg-[var(--running)]" : "bg-[var(--failed)]")}
            />
            Conductor {conductorOnline ? "up" : "down"}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className={cn("w-1.5 h-1.5 rounded-full", arkdOnline ? "bg-[var(--running)]" : "bg-muted-foreground/30")}
            />
            ArkD {arkdOnline ? "up" : "off"}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                routerStatus ? "bg-[var(--running)]" : "bg-muted-foreground/30",
              )}
            />
            Router {routerStatus ? "up" : "off"}
          </span>
          <span className="ml-auto text-muted-foreground/60">
            {counts.running ?? 0} running, {counts.total ?? 0} total
          </span>
        </div>

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
        {!needsAttention && (
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
                      onClick={() => onNavigate("sessions")}
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
            <div className="border border-border rounded-lg divide-y divide-border/50 overflow-hidden">
              {failedSessions.slice(0, 10).map((s) => (
                <div
                  key={s.session_id || s.id}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-accent transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-foreground truncate">{s.summary || s.session_id || s.id}</div>
                    <div className="text-[11px] text-[var(--failed)] font-mono mt-0.5">
                      {s.error || s.stage || "failed"}
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0 ml-3">
                    <button
                      type="button"
                      onClick={() => onNavigate("sessions")}
                      aria-label="View failed session"
                      className={cn(
                        "h-6 px-2 rounded text-[10px] font-medium",
                        "border border-border bg-transparent text-foreground",
                        "hover:bg-accent transition-colors cursor-pointer",
                        "flex items-center gap-1",
                      )}
                    >
                      <Eye size={10} /> View
                    </button>
                    <button
                      type="button"
                      onClick={() => onNavigate("sessions")}
                      aria-label="Restart failed session"
                      className={cn(
                        "h-6 px-2 rounded text-[10px] font-medium",
                        "border border-[var(--running)] bg-transparent text-[var(--running)]",
                        "hover:bg-[var(--diff-add-bg)] transition-colors cursor-pointer",
                        "flex items-center gap-1",
                      )}
                    >
                      <RotateCcw size={10} /> Restart
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cost summary line */}
        {(costs.today > 0 || costs.week > 0) && (
          <div className="flex items-center gap-4 text-[12px] text-muted-foreground border-t border-border/50 pt-4">
            <span>
              Today: <span className="font-mono font-medium text-foreground">{fmtCost(costs.today)}</span>
            </span>
            <span>
              This week: <span className="font-mono font-medium text-foreground">{fmtCost(costs.week)}</span>
            </span>
            <button
              onClick={() => onNavigate("costs")}
              aria-label="View all costs"
              className="text-[11px] text-primary hover:underline ml-auto cursor-pointer bg-transparent border-none"
            >
              View all costs
            </button>
          </div>
        )}

        {/* Recent activity feed */}
        {recentEvents.length > 0 && (
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
              Recent Activity
            </h3>
            <div className="space-y-0">
              {recentEvents.slice(0, 8).map((ev, i) => (
                <div
                  key={ev.sessionId + "-" + ev.created_at + "-" + i}
                  className="flex items-start gap-2.5 py-1.5 text-[12px]"
                >
                  <span className="text-muted-foreground/60 font-mono shrink-0 w-[44px] text-right">
                    {new Date(ev.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="text-muted-foreground truncate">
                    <span className="text-foreground">{ev.sessionSummary || ev.sessionId}</span>
                    {" -- "}
                    {formatEventType(ev.type)}
                    {ev.data?.message ? ": " + ev.data.message.slice(0, 60) : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
