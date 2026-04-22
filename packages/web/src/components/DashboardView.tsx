import { useMemo } from "react";
import { fmtCost, relTime } from "../util.js";
import { cn } from "../lib/utils.js";
import { AlertCircle, CheckCircle2, Clock, PlugZap, RotateCcw } from "lucide-react";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";
import { useDashboardSummaryQuery, useRunningSessionsQuery } from "../hooks/useDashboardQuery.js";
import { Button } from "./ui/button.js";

/**
 * Dashboard -- "Fleet overview" of the sessions surface.
 *
 * Visual target: /tmp/ark-design-v2/packages/web/design-midnight-circuit.html
 * and /tmp/ark-design-v2/ui_kits/web/DashboardPage.jsx. Real-data hooks are
 * preserved; this is a render-layer rewrite.
 *
 * Layout, top to bottom:
 *   1. Heading row -- "Fleet overview" title + "updated Ns ago" stamp.
 *   2. Four stat tiles -- Active / Total / Tokens 24h / Cost 24h.
 *   3. Budget banner (only when a daily/weekly/monthly budget is set).
 *   4. Attention sections (only when there are waiting / failed sessions).
 *   5. Recent activity card -- up to 6 rows of recent running-or-latest sessions.
 */

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

/** `fetch()` throws a TypeError with "Failed to fetch" when the network layer
 * rejects outright (server down, DNS fail, CORS pre-response). Distinguishing
 * this from a real RPC error lets us show an actionable "API unreachable" hint
 * instead of the raw browser message. */
function isNetworkUnreachable(err: unknown): boolean {
  if (!err) return false;
  const msg = (err as { message?: string }).message ?? "";
  return err instanceof TypeError || msg.includes("Failed to fetch") || msg.includes("NetworkError");
}

function DashboardErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const unreachable = isNetworkUnreachable(error);
  const base = typeof window !== "undefined" ? window.location.origin : "";
  const message = (error as { message?: string })?.message ?? "unknown error";

  return (
    <div className="flex flex-col items-center justify-center flex-1 w-full h-full gap-3 px-6 text-center">
      <div className="rounded-full bg-[var(--bg-hover)] p-3 text-[var(--fg-muted)]">
        {unreachable ? <PlugZap className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium text-[var(--fg)]">
          {unreachable ? "Can't reach the Ark API" : "Dashboard request failed"}
        </div>
        <div className="text-xs text-[var(--fg-muted)] max-w-md">
          {unreachable ? (
            <>
              Tried <code className="font-[family-name:var(--font-mono)] text-[11px]">{base}/api/rpc</code> and got no
              response. Is <code className="font-[family-name:var(--font-mono)] text-[11px]">make dev</code> running?
            </>
          ) : (
            message
          )}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
        <RotateCcw className="h-3.5 w-3.5" />
        Retry
      </Button>
    </div>
  );
}

function StatTile({
  label,
  value,
  delta,
  deltaTone = "neutral",
}: {
  label: string;
  value: string | number;
  delta?: string;
  deltaTone?: "good" | "bad" | "neutral";
}) {
  return (
    <div className="stat-tile">
      <span className="stat-tile-label">{label}</span>
      <span className="stat-tile-value">{value}</span>
      {delta && <span className={cn("stat-tile-delta", deltaTone)}>{delta}</span>}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="dashboard-root">
      <div className="dashboard-inner">
        <div className="dashboard-heading">
          <h1 className="dashboard-title">Fleet overview</h1>
          <span className="dashboard-updated">updating...</span>
        </div>
        <div className="dashboard-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="stat-tile skeleton-shimmer" aria-hidden="true" style={{ height: 76 }} />
          ))}
        </div>
        <div className="dashboard-card skeleton-shimmer" style={{ height: 240 }} aria-hidden="true" />
        <span className="sr-only">Loading dashboard</span>
      </div>
    </div>
  );
}

/** Normalize a raw session row to the fields we render in the dashboard rows. */
type RowSession = {
  id: string;
  status: string;
  summary: string;
  agent: string;
  cost?: number;
  updated_at?: string;
  created_at?: string;
  stage?: string;
  error?: string;
};

function toRow(s: any): RowSession {
  const id = s.session_id || s.id;
  return {
    id,
    status: s.status || "stopped",
    summary: s.summary || id,
    agent: s.agent || "--",
    cost: typeof s.cost === "number" ? s.cost : undefined,
    updated_at: s.updated_at,
    created_at: s.created_at,
    stage: s.stage,
    error: s.error,
  };
}

function RecentRow({ s, onSelect }: { s: RowSession; onSelect?: (id: string) => void }) {
  const statusClass = ["running", "waiting", "completed", "failed", "stopped"].includes(s.status)
    ? s.status
    : "stopped";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(s.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(s.id);
        }
      }}
      className="dashboard-row"
    >
      <div className="flex items-center gap-2">
        <span className={cn("status-dot-sm", statusClass)} aria-hidden="true" />
        <span className="session-card-id">{s.id}</span>
      </div>
      <div className="dashboard-row-summary">{s.summary}</div>
      <div className="dashboard-row-agent">{s.agent}</div>
      <div className="dashboard-row-cost">{s.cost != null ? fmtCost(s.cost) : ""}</div>
      <div className="dashboard-row-time">{relTime(s.updated_at || s.created_at)}</div>
    </div>
  );
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
  const sessions = sessionsQuery.data;

  const { running, waitingSessions, failedSessions, recentRows } = useMemo(() => {
    const rows = ((sessions ?? []) as any[]).map(toRow);
    const running = rows.filter((s) => s.status === "running").length;
    const waitingSessions = rows.filter((s) => s.status === "waiting" || s.status === "blocked");
    const failedSessions = rows.filter((s) => s.status === "failed");
    // Recent activity = most-recently-updated across all non-archived sessions.
    const recentRows = [...rows].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")).slice(0, 6);
    return { running, waitingSessions, failedSessions, recentRows };
  }, [sessions]);

  if (summaryQuery.isError) {
    return <DashboardErrorState error={summaryQuery.error} onRetry={() => summaryQuery.refetch()} />;
  }
  if (!data) return <DashboardSkeleton />;

  const { counts, costs } = data;
  const totalSessions = Object.values(counts || {}).reduce((a, b) => a + (b || 0), 0);

  const budget = costs.budget?.daily?.limit
    ? costs.budget.daily
    : costs.budget?.weekly?.limit
      ? costs.budget.weekly
      : costs.budget?.monthly?.limit
        ? costs.budget.monthly
        : null;
  const hasBudgetWarning = budget && (budget.warning || budget.exceeded);

  const needsAttention = waitingSessions.length > 0 || failedSessions.length > 0;
  const dataUpdatedMs = summaryQuery.dataUpdatedAt;
  const updatedLabel = dataUpdatedMs ? relTime(new Date(dataUpdatedMs).toISOString()) : "just now";

  return (
    <div className="dashboard-root">
      <div className="dashboard-inner">
        <div className="dashboard-heading">
          <h1 className="dashboard-title">Fleet overview</h1>
          <span className="dashboard-updated">updated {updatedLabel}</span>
        </div>

        <div className="dashboard-grid">
          <StatTile label="Active" value={running} />
          <StatTile label="Total" value={totalSessions} />
          <StatTile label="Cost today" value={fmtCost(costs.today || 0)} />
          <StatTile label="Cost 7d" value={fmtCost(costs.week || 0)} />
        </div>

        {hasBudgetWarning && budget && (
          <div className="budget-banner">
            <div className="budget-banner-row">
              <span className={cn("budget-banner-label", budget.exceeded ? "exceeded" : "warning")}>
                {budget.exceeded ? "Budget exceeded" : "Budget warning"}
              </span>
              <span className="budget-banner-amount">
                {fmtCost(budget.spent)} / {fmtCost(budget.limit)}
              </span>
            </div>
            <div className="budget-banner-track">
              <div
                className={cn("budget-banner-fill", budget.exceeded ? "exceeded" : "warning")}
                style={{ width: Math.min(100, budget.pct) + "%" }}
              />
            </div>
          </div>
        )}

        {waitingSessions.length > 0 && (
          <section>
            <h3 className="dashboard-section-title">
              <Clock size={13} className="text-[var(--waiting)]" />
              Waiting for input
              <span className="section-count">({waitingSessions.length})</span>
            </h3>
            <div className="dashboard-card">
              {waitingSessions.slice(0, 6).map((s) => (
                <RecentRow key={s.id} s={s} onSelect={onSelectSession} />
              ))}
            </div>
          </section>
        )}

        {failedSessions.length > 0 && (
          <section>
            <h3 className="dashboard-section-title">
              <AlertCircle size={13} className="text-[var(--failed)]" />
              Failed
              <span className="section-count">({failedSessions.length})</span>
            </h3>
            <div className="dashboard-card">
              {failedSessions.slice(0, 6).map((s) => (
                <RecentRow key={s.id} s={s} onSelect={onSelectSession} />
              ))}
            </div>
          </section>
        )}

        <section>
          <h3 className="dashboard-section-title">Recent activity</h3>
          {recentRows.length === 0 ? (
            <div className="dashboard-card">
              <div className="dashboard-empty">
                {!needsAttention ? (
                  <>
                    <CheckCircle2 size={16} className="text-[var(--running)] opacity-70" />
                    No sessions yet. Press n to start one.
                  </>
                ) : (
                  <>No recent activity</>
                )}
              </div>
            </div>
          ) : (
            <div className="dashboard-card">
              {recentRows.map((s) => (
                <RecentRow key={s.id} s={s} onSelect={onSelectSession} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
