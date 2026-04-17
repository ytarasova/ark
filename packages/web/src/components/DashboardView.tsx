import { useEffect, useState } from "react";
import { api } from "../hooks/useApi.js";
import { useSmartPoll } from "../hooks/useSmartPoll.js";
import { fmtCost } from "../util.js";
import { cn } from "../lib/utils.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";
import { StatusDot } from "./StatusDot.js";
import { Activity, DollarSign, Heart } from "lucide-react";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

// Theme colors for charts and status
const STATUS_COLORS: Record<string, string> = {
  running: "text-[var(--running)]",
  waiting: "text-[var(--waiting)]",
  stopped: "text-muted-foreground",
  failed: "text-[var(--failed)]",
  completed: "text-[var(--completed)]",
  ready: "text-muted-foreground/60",
  archived: "text-muted-foreground/40",
};

const STATUS_BG: Record<string, string> = {
  running: "bg-[var(--running)]/10",
  waiting: "bg-[var(--waiting)]/10",
  stopped: "bg-secondary/50",
  failed: "bg-[var(--failed)]/10",
  completed: "bg-[var(--completed)]/10",
};

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

export function DashboardView({ onNavigate, readOnly: _readOnly, daemonStatus }: DashboardViewProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api
      .getDashboardSummary()
      .then(setData)
      .catch((e: any) => setError(e.message));
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

  const { counts, costs, recentEvents, system, activeCompute } = data;
  const hasBudget = costs.budget?.daily?.limit || costs.budget?.weekly?.limit || costs.budget?.monthly?.limit;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-5 px-6 overflow-y-auto">
      {/* Fleet Status Widget */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-[13px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex items-center gap-2">
            <Activity size={14} className="opacity-50" />
            Fleet Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {(["running", "waiting", "stopped", "failed", "completed"] as const).map((status) => (
              <button
                key={status}
                onClick={() => onNavigate("sessions")}
                className={cn(
                  "flex flex-col items-center gap-1.5 p-3 rounded-lg transition-colors cursor-pointer",
                  STATUS_BG[status],
                  "hover:ring-1 hover:ring-ring/30",
                )}
              >
                <StatusDot status={status} />
                <span className={cn("text-2xl font-bold font-mono", STATUS_COLORS[status])}>{counts[status] ?? 0}</span>
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{status}</span>
              </button>
            ))}
          </div>
          <div className="flex gap-4 mt-3 pt-3 border-t border-border/50 text-[12px] text-muted-foreground">
            <span>{counts.total ?? 0} total sessions</span>
            <span>{activeCompute} active compute</span>
          </div>
        </CardContent>
      </Card>

      {/* System Health Widget */}
      <Card data-testid="system-health-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-[13px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex items-center gap-2">
            <Heart size={14} className="opacity-50" />
            System Health
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {/* Conductor status -- use live probe when available, fall back to dashboard data */}
          {(() => {
            const online = daemonStatus ? daemonStatus.conductor.online : system.conductor;
            return (
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-muted-foreground">Conductor</span>
                <span
                  className={cn(
                    "text-[12px] font-medium flex items-center gap-1.5",
                    online ? "text-[var(--running)]" : "text-[var(--failed)]",
                  )}
                >
                  <span
                    className={cn("w-1.5 h-1.5 rounded-full", online ? "bg-[var(--running)]" : "bg-[var(--failed)]")}
                  />
                  {online ? "online" : "offline"}
                </span>
              </div>
            );
          })()}
          {/* ArkD status -- only shown when daemon probing is available */}
          {(() => {
            const online = daemonStatus?.arkd.online ?? false;
            return (
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-muted-foreground">ArkD</span>
                <span
                  className={cn(
                    "text-[12px] font-medium flex items-center gap-1.5",
                    online ? "text-[var(--running)]" : "text-muted-foreground/50",
                  )}
                >
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full",
                      online ? "bg-[var(--running)]" : "bg-muted-foreground/30",
                    )}
                  />
                  {online ? "online" : "offline"}
                </span>
              </div>
            );
          })()}
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-muted-foreground">Router</span>
            <span
              className={cn(
                "text-[12px] font-medium flex items-center gap-1.5",
                system.router ? "text-[var(--running)]" : "text-muted-foreground/50",
              )}
            >
              <span
                className={cn(
                  "w-1.5 h-1.5 rounded-full",
                  system.router ? "bg-[var(--running)]" : "bg-muted-foreground/30",
                )}
              />
              {system.router ? "online" : "disabled"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-muted-foreground">Compute</span>
            <span className="text-[12px] font-medium text-foreground">{activeCompute} active</span>
          </div>
        </CardContent>
      </Card>

      {/* Cost Summary Widget */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[13px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex items-center gap-2">
            <DollarSign size={14} className="opacity-50" />
            Cost Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-muted-foreground">Today</span>
              <span className="text-[14px] font-bold font-mono text-[var(--running)]">{fmtCost(costs.today)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-muted-foreground">This week</span>
              <span className="text-[13px] font-semibold font-mono text-foreground">{fmtCost(costs.week)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-muted-foreground">This month</span>
              <span className="text-[13px] font-semibold font-mono text-foreground">{fmtCost(costs.month)}</span>
            </div>

            {/* Budget bar */}
            {hasBudget &&
              (() => {
                const b = costs.budget.daily?.limit
                  ? costs.budget.daily
                  : costs.budget.weekly?.limit
                    ? costs.budget.weekly
                    : costs.budget.monthly;
                if (!b?.limit) return null;
                const pct = Math.min(100, b.pct);
                const barColor = b.exceeded
                  ? "bg-[var(--failed)]"
                  : b.warning
                    ? "bg-[var(--waiting)]"
                    : "bg-[var(--running)]";
                return (
                  <div className="pt-2 border-t border-border/50">
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                      <span>Budget</span>
                      <span>
                        {fmtCost(b.spent)} / {fmtCost(b.limit)}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                      <div
                        className={cn("h-full rounded-full transition-all", barColor)}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-right text-[10px] text-muted-foreground mt-0.5">{pct.toFixed(1)}%</div>
                  </div>
                );
              })()}

            {/* Cost by model breakdown */}
            {Object.keys(costs.byModel).length > 0 && (
              <div className="pt-2 border-t border-border/50 space-y-1">
                {Object.entries(costs.byModel)
                  .sort(([, a], [, b]) => b - a)
                  .map(([model, cost]) => (
                    <div key={model} className="flex items-center justify-between">
                      <span className="text-[11px] text-[var(--waiting)] font-mono uppercase">{model}</span>
                      <span className="text-[11px] font-mono text-muted-foreground">{fmtCost(cost)}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>

          <button
            onClick={() => onNavigate("costs")}
            className="w-full mt-3 text-[11px] text-primary hover:underline text-center"
          >
            View all costs
          </button>
        </CardContent>
      </Card>

      {/* Recent Activity Widget */}
      <Card className="lg:col-span-1">
        <CardHeader className="pb-2">
          <CardTitle className="text-[13px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex items-center gap-2">
            <Activity size={14} className="opacity-50" />
            Recent Activity
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recentEvents.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">No recent events</div>
          ) : (
            <div className="divide-y divide-border/50">
              {recentEvents.slice(0, 10).map((ev, i) => (
                <div
                  key={`${ev.sessionId}-${ev.created_at}-${i}`}
                  className="px-4 py-2 hover:bg-accent transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                      {new Date(ev.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className="text-[11px] text-foreground truncate">{ev.sessionSummary || ev.sessionId}</span>
                  </div>
                  <div className="ml-[44px] text-[10px] text-muted-foreground">
                    {formatEventType(ev.type)}
                    {ev.data?.message ? ` - ${ev.data.message.slice(0, 60)}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top Cost Sessions Widget */}
      {data.topCostSessions && data.topCostSessions.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[13px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex items-center gap-2">
              <DollarSign size={14} className="opacity-50" />
              Top Cost Sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border/50">
              {data.topCostSessions.slice(0, 5).map((s, i) => (
                <div
                  key={`${s.sessionId}-${i}`}
                  className="px-4 py-2 hover:bg-accent transition-colors cursor-pointer"
                  onClick={() => onNavigate("sessions")}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-foreground truncate">{s.summary || s.sessionId}</span>
                    <span className="text-[11px] font-mono text-[var(--primary)]">{fmtCost(s.cost)}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function formatEventType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
