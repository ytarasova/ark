import { useMemo } from "react";
import { fmtCost, relTime } from "../util.js";
import { cn } from "../lib/utils.js";
import { AlertCircle, CheckCircle2, Clock, PlugZap, RotateCcw } from "lucide-react";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";
import { useDashboardSummaryQuery, useRunningSessionsQuery } from "../hooks/useDashboardQuery.js";
import { Button } from "./ui/button.js";
import { Avatar } from "./ui/Avatar.js";

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
  runtime?: string;
  compute?: string;
  tokens?: number;
  cost?: number;
  updated_at?: string;
  created_at?: string;
  stage?: string;
  error?: string;
  progress?: number;
};

function toRow(s: any): RowSession {
  const id = s.session_id || s.id;
  const tokensIn = typeof s.tokens_in === "number" ? s.tokens_in : 0;
  const tokensOut = typeof s.tokens_out === "number" ? s.tokens_out : 0;
  const tokens =
    typeof s.tokens_total === "number" ? s.tokens_total : tokensIn + tokensOut > 0 ? tokensIn + tokensOut : undefined;
  return {
    id,
    status: s.status || "stopped",
    summary: s.summary || id,
    agent: s.agent || "--",
    runtime: s.runtime || s.agent_runtime,
    compute: s.compute_provider || s.compute_kind,
    tokens,
    cost: typeof s.cost === "number" ? s.cost : undefined,
    updated_at: s.updated_at,
    created_at: s.created_at,
    stage: s.stage,
    error: s.error,
    progress: typeof s.progress === "number" ? s.progress : undefined,
  };
}

function fmtTokens(n?: number): string {
  if (n == null || n <= 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tok`;
  return `${Math.round(n)} tok`;
}

function statusBadge(status: string): { label: string; bg: string; color: string; border: string; dot: string } {
  switch (status) {
    case "running":
      return {
        label: "running",
        bg: "linear-gradient(180deg, rgba(96,165,250,.18), rgba(96,165,250,.06))",
        color: "#7dbbff",
        border: "rgba(96,165,250,.35)",
        dot: "#60a5fa",
      };
    case "completed":
      return {
        label: "completed",
        bg: "linear-gradient(180deg, rgba(52,211,153,.15), rgba(52,211,153,.04))",
        color: "#34d399",
        border: "rgba(52,211,153,.32)",
        dot: "#34d399",
      };
    case "waiting":
    case "blocked":
      return {
        label: "waiting",
        bg: "linear-gradient(180deg, rgba(251,191,36,.15), rgba(251,191,36,.04))",
        color: "#fbbf24",
        border: "rgba(251,191,36,.32)",
        dot: "#fbbf24",
      };
    case "failed":
      return {
        label: "failed",
        bg: "linear-gradient(180deg, rgba(248,113,113,.18), rgba(248,113,113,.05))",
        color: "#f87171",
        border: "rgba(248,113,113,.35)",
        dot: "#f87171",
      };
    default:
      return {
        label: status,
        bg: "linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.01))",
        color: "var(--fg-muted)",
        border: "var(--border)",
        dot: "var(--stopped)",
      };
  }
}

/**
 * Rich dashboard card — rebuilt from `cards-session.html` .card-demo.
 * Surface with lighting gradient, glow-fill progress rail, avatars.
 */
function SessionTile({ s, onSelect }: { s: RowSession; onSelect?: (id: string) => void }) {
  const badge = statusBadge(s.status);
  const pctRaw = s.progress ?? (s.status === "completed" ? 1 : s.status === "failed" ? 0.35 : 0.62);
  const pct = Math.max(0, Math.min(1, pctRaw));
  const fillBg =
    s.status === "completed"
      ? "linear-gradient(90deg, #34d399, #22b07e)"
      : s.status === "failed"
        ? "linear-gradient(90deg, #f87171, #dc5252)"
        : "linear-gradient(90deg, #8b7aff, var(--primary))";
  const fillGlow =
    s.status === "completed"
      ? "0 0 8px rgba(52,211,153,.5), 0 1px 0 rgba(255,255,255,.15) inset"
      : s.status === "failed"
        ? "0 0 8px rgba(248,113,113,.4), 0 1px 0 rgba(255,255,255,.15) inset"
        : "0 0 8px rgba(107,89,222,.6), 0 1px 0 rgba(255,255,255,.15) inset";

  const tokensLabel = fmtTokens(s.tokens);
  const costLabel = s.cost != null ? fmtCost(s.cost) : "";
  const relLabel = relTime(s.updated_at || s.created_at);

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
      className={cn(
        "relative flex flex-col gap-[9px] px-[14px] py-[13px] rounded-[9px] cursor-pointer",
        "border border-[var(--border)] border-t-[rgba(255,255,255,0.07)] border-b-[rgba(0,0,0,0.5)]",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_0_-1px_0_rgba(0,0,0,0.4),0_1px_2px_rgba(0,0,0,0.4),0_8px_18px_-4px_rgba(0,0,0,0.4)]",
        "hover:border-[rgba(107,89,222,0.4)] transition-colors",
      )}
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,.025) 0%, rgba(255,255,255,0) 25%, rgba(0,0,0,.15) 100%), var(--bg-card)",
      }}
    >
      {/* Head: status badge + id */}
      <div className="flex items-center justify-between">
        <span
          className="inline-flex items-center gap-[5px] h-[20px] px-[8px] rounded-full border font-[family-name:var(--font-sans)] text-[10.5px] font-medium"
          style={{
            background: badge.bg,
            color: badge.color,
            borderColor: badge.border,
            boxShadow: "0 1px 0 rgba(255,255,255,.04) inset, 0 1px 2px rgba(0,0,0,.3)",
          }}
        >
          <span
            aria-hidden
            className="w-[5px] h-[5px] rounded-full"
            style={{
              background: badge.dot,
              boxShadow: s.status === "running" ? "0 0 5px rgba(96,165,250,.7)" : undefined,
            }}
          />
          {badge.label}
        </span>
        <span className="font-[family-name:var(--font-mono-ui)] text-[10px] text-[var(--fg-faint)] tracking-[0.03em]">
          {s.id}
        </span>
      </div>

      {/* Title */}
      <div className="font-[family-name:var(--font-sans)] text-[14px] leading-[19px] font-semibold text-[var(--fg)] tracking-[-0.01em] truncate">
        {s.summary}
      </div>

      {/* Sub-meta row: stage/info + avatars */}
      <div className="flex items-center gap-[12px] font-[family-name:var(--font-mono-ui)] text-[11px] text-[var(--fg-muted)]">
        <span className="truncate">
          {s.stage ? `${s.stage}` : s.error ? s.error.slice(0, 40) : relLabel ? `updated ${relLabel} ago` : ""}
        </span>
        <span className="flex-1" />
        {s.agent && s.agent !== "--" && (
          <span className="inline-flex items-center -space-x-[5px]">
            <Avatar name={s.agent} size="sm" className="!border-[1.5px] border-[var(--bg-card)]" />
          </span>
        )}
      </div>

      {/* Progress lane (glow fill) */}
      <div
        className="relative h-[4px] rounded-full overflow-hidden"
        style={{
          background: "linear-gradient(180deg, rgba(0,0,0,.4), rgba(0,0,0,.2))",
          boxShadow: "0 1px 1px rgba(0,0,0,.5) inset, 0 1px 0 rgba(255,255,255,.03)",
        }}
      >
        <div
          className="absolute top-0 left-0 h-full rounded-full"
          style={{ width: `${pct * 100}%`, background: fillBg, boxShadow: fillGlow }}
        />
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-[12px] font-[family-name:var(--font-mono-ui)] text-[11px] text-[var(--fg-muted)] tabular-nums">
        {relLabel && <span className="text-[var(--fg)]">{relLabel}</span>}
        {tokensLabel && <span className="text-[var(--fg)]">{tokensLabel}</span>}
        {costLabel && <span className="text-[var(--fg)]">{costLabel}</span>}
        <span className="flex-1" />
        <div className="flex gap-[5px]">
          {s.runtime && <RuntimeTag>{s.runtime}</RuntimeTag>}
          {s.compute && <RuntimeTag>{s.compute}</RuntimeTag>}
        </div>
      </div>
    </div>
  );
}

function RuntimeTag({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-[family-name:var(--font-mono-ui)] text-[9.5px] uppercase tracking-[0.05em] text-[var(--fg)] px-[7px] py-[3px] rounded-[4px] border border-[var(--border)]"
      style={{
        background: "linear-gradient(180deg, #252540, #1a1a2d)",
        borderTopColor: "rgba(255,255,255,.08)",
        boxShadow: "0 1px 0 rgba(255,255,255,.04) inset, 0 1px 2px rgba(0,0,0,.3)",
      }}
    >
      {children}
    </span>
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
            <div className="grid gap-[12px] grid-cols-1 md:grid-cols-2">
              {waitingSessions.slice(0, 6).map((s) => (
                <SessionTile key={s.id} s={s} onSelect={onSelectSession} />
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
            <div className="grid gap-[12px] grid-cols-1 md:grid-cols-2">
              {failedSessions.slice(0, 6).map((s) => (
                <SessionTile key={s.id} s={s} onSelect={onSelectSession} />
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
            <div className="grid gap-[12px] grid-cols-1 md:grid-cols-2">
              {recentRows.map((s) => (
                <SessionTile key={s.id} s={s} onSelect={onSelectSession} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
