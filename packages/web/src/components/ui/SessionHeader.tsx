import { ArrowLeft, Copy, Maximize2, Minimize2, Terminal } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { resolveInlineDisplay, type InlineModelLike } from "../../lib/inline-display.js";
import { type SessionStatus } from "./StatusDot.js";
import type { StageProgress } from "./StageProgressBar.js";

export interface SessionHeaderKv {
  /** Key label, shown in muted mono. */
  k: string;
  /** Value. `link: true` renders as primary-colored clickable text. */
  v: React.ReactNode;
  link?: boolean;
  mono?: boolean;
  error?: boolean;
}

export interface SessionHeaderProps extends React.ComponentProps<"div"> {
  sessionId: string;
  summary: string;
  status: SessionStatus;
  /** Breadcrumb segments (e.g. ["ark", "sessions"]). */
  breadcrumb?: string[];
  /** Ancestor sessions, rendered as clickable crumbs between the static
   *  `ark / sessions` prefix and the current session id. */
  ancestors?: { id: string; label: string }[];
  /** When provided, renders a Maximize/Minimize toggle in the title action row. */
  onMaximize?: () => void;
  maximized?: boolean;
  /** When provided, renders a Back arrow in the title action row that
   *  dismisses the detail view (e.g. returns to the session dashboard). */
  onBack?: () => void;
  /** Labeled info blocks (runtime, agent, flow, compute, branch, etc.). */
  kvs?: SessionHeaderKv[];
  /** Runtime name (claude|codex|gemini|goose). */
  runtime?: string;
  /** Agent name. */
  agent?: string;
  /** Compute target (local, ec2, k8s…). */
  compute?: string;
  /** Optional stage text shown next to the status pill ("running · implement"). */
  stageLabel?: string;
  /** Ticker values (tokens, spend, elapsed). Rendered right-aligned in the
   *  meta strip. When `bump` is true and the session is running, the value
   *  subtly blips to signal a live update. */
  tickers?: { label: string; value: string; bump?: boolean }[];
  /** Action buttons (primary/secondary, shown right of the title row). */
  actions?: React.ReactNode;
  onCopyId?: () => void;
  /** Optional: open terminal/logs pane. */
  onOpenTerminal?: () => void;
  /** Currently selected stage filter (null = show all). */
  selectedStage?: string | null;
  /** Called when a stage is clicked in the pipeline. */
  onStageClick?: (stageName: string) => void;
  /** Stages -- currently only used by legacy StagePipeline callers. */
  stages?: StageProgress[];
  /** Compact "N/M stages" + bar, rendered on the right of the meta strip. */
  stageProgress?: { completed: number; total: number; pct: number };
  /** Legacy: cost chip (tokens / $). If given but no `tickers`, rendered on the right. */
  cost?: string;
  /**
   * Optional session row. When provided, the header detects inline-flow /
   * inline-agent dispatches and rewrites the `agent` + `flow` meta blocks to
   * show the actual `(runtime, model)` binding instead of the literal
   * `inline` / synthetic `inline-s-…` strings.
   */
  session?: any;
  /**
   * Catalog from `model/list`, used to resolve a model id to its display
   * name when rendering an inline agent's binding.
   */
  models?: InlineModelLike[];
}

/**
 * Session detail header -- rebuilt from
 * `/tmp/ark-design-system/preview/chrome-session-header.html` + the
 * user-06-desired-header-ticker reference.
 *
 * Three stacked rows (tabs live in <ContentTabs> below):
 *   0. ticker   (44px, 0 18px): breadcrumb + copyable id on the left; the
 *               animated status pill (CHIPPULSE) + ticker values (tokens,
 *               spend, elapsed) on the right, each mono-ui 10px uppercase.
 *   1. title    (padding 14px 18px 12px): summary (17px/600/-0.015em),
 *               action icons + primary/secondary btns.
 *   2. meta     (padding 8px 18px, bg rgba(0,0,0,.18)): LABELed blocks
 *               (runtime / agent / compute / flow / branch).
 */
export function SessionHeader({
  sessionId,
  summary,
  status,
  breadcrumb,
  ancestors,
  onMaximize,
  maximized,
  onBack,
  kvs,
  runtime,
  agent,
  compute,
  stageLabel,
  tickers,
  actions,
  onCopyId,
  onOpenTerminal,
  stageProgress,
  cost,
  session,
  models,
  className,
  ...props
}: SessionHeaderProps) {
  const crumbs = breadcrumb ?? ["ark", "sessions"];
  const statusMeta = getStatusPillStyle(status);
  const isRunning = status === "running";

  // Inline-dispatch override: when the session was created with an inline
  // flow / inline agent, the header otherwise shows the literal `inline` and
  // the synthetic `inline-s-<id>` flow name -- both Ark internals. Resolve
  // the actual binding so users see something meaningful.
  const inline = session ? resolveInlineDisplay(session, models) : null;
  const effectiveAgent = inline?.isInlineAgent && inline.agentLabel ? inline.agentLabel : agent;

  // Additional labeled blocks derived from runtime/agent/compute props + kvs.
  const labeled: { k: string; v: React.ReactNode; mono?: boolean; link?: boolean; error?: boolean }[] = [];
  if (runtime) labeled.push({ k: "runtime", v: runtime });
  if (effectiveAgent) labeled.push({ k: "agent", v: effectiveAgent });
  if (compute) labeled.push({ k: "compute", v: compute });
  if (kvs && kvs.length > 0) {
    for (const kv of kvs) {
      if (kv.k === "flow" && inline?.isInlineFlow) {
        const tip = `${inline.inlineFlowName ?? "inline"} · ${inline.inlineFlowStageCount} stage${
          inline.inlineFlowStageCount === 1 ? "" : "s"
        }`;
        labeled.push({
          ...kv,
          v: (
            <span className="inline-flex items-baseline gap-[4px]">
              <i className="not-italic">Inline flow</i>
              <span
                title={tip}
                aria-label={tip}
                data-testid="inline-flow-tooltip"
                className="text-[var(--fg-faint)] cursor-help select-none text-[10px] tracking-normal"
              >
                (?)
              </span>
            </span>
          ),
        });
      } else {
        labeled.push(kv);
      }
    }
  }

  return (
    <div className={cn("shrink-0 flex flex-col border-b border-[var(--border)] bg-[var(--bg)]", className)} {...props}>
      {/* ── Ticker strip (44px): breadcrumb+id · status pill · stats ── */}
      <div
        className="h-[44px] shrink-0 px-[18px] flex items-center gap-[12px] border-b border-[var(--border)]"
        style={{ background: "rgba(0,0,0,.22)" }}
      >
        <div className="flex items-center gap-[6px] min-w-0 flex-1 overflow-hidden font-[family-name:var(--font-mono-ui)] text-[11px] font-medium text-[var(--fg-faint)] tracking-[0.02em]">
          {crumbs.map((c, i) => (
            <span key={`${c}-${i}`} className="inline-flex items-center gap-[6px] shrink-0">
              <span className="hover:text-[var(--fg-muted)] transition-colors">{c}</span>
              <span className="opacity-40">/</span>
            </span>
          ))}
          {ancestors?.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-[6px] min-w-0">
              <a
                href={`#/sessions/${a.id}`}
                title={a.label}
                className="text-[var(--fg-muted)] hover:text-[var(--fg)] truncate max-w-[200px] no-underline hover:underline"
              >
                {a.label}
              </a>
              <span className="opacity-40 shrink-0">/</span>
            </span>
          ))}
          <span className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--fg)] normal-case tracking-[0.02em] truncate">
            {sessionId}
          </span>
          {onCopyId && (
            <button
              type="button"
              onClick={onCopyId}
              title="Copy session id"
              aria-label="Copy session id"
              data-testid="breadcrumb-copy-id"
              className="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0 rounded-[4px] bg-transparent border-0 p-0 text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
            >
              <Copy size={12} strokeWidth={1.75} />
            </button>
          )}
        </div>

        <span
          className="inline-flex items-center gap-[6px] px-[10px] py-[3px] rounded-full shrink-0 border font-[family-name:var(--font-mono-ui)] text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{
            background: statusMeta.bg,
            color: statusMeta.color,
            borderColor: statusMeta.border,
          }}
        >
          <i
            aria-hidden
            className="w-[6px] h-[6px] rounded-full"
            style={{
              background: "currentColor",
              boxShadow: "0 0 6px currentColor",
              animation: isRunning ? "chipPulse 1.6s ease-in-out infinite" : undefined,
            }}
          />
          {status}
        </span>

        {tickers && tickers.length > 0 && (
          <span className="inline-flex items-center gap-[12px] shrink-0">
            {tickers.map((t, i) => (
              <span
                key={i}
                className="inline-flex items-baseline gap-[4px] font-[family-name:var(--font-mono-ui)] text-[10px] uppercase tracking-[0.04em] text-[var(--fg-muted)]"
              >
                <span
                  className={cn(
                    "text-[var(--fg)] font-semibold tabular-nums normal-case tracking-normal",
                    t.bump && isRunning && "bump",
                  )}
                >
                  {t.value}
                </span>
                {t.label && <span>{t.label}</span>}
              </span>
            ))}
          </span>
        )}
        {!tickers && cost && (
          <span className="font-[family-name:var(--font-mono)] text-[11px] font-normal text-[var(--fg)] tabular-nums shrink-0">
            {cost}
          </span>
        )}
      </div>

      {/* ── Title row: summary + action buttons ───────────────────── */}
      <div className="px-[18px] pt-[14px] pb-[12px] flex items-center gap-[12px] border-b border-[var(--border-light)]">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title="Back to dashboard"
            aria-label="Back to dashboard"
            className="inline-flex items-center justify-center w-[26px] h-[26px] shrink-0 rounded-[6px] bg-transparent border-0 p-0 text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          >
            <ArrowLeft size={16} strokeWidth={1.75} />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="m-0 font-[family-name:var(--font-sans)] text-[17px] leading-[1.25] font-semibold text-[var(--fg)] tracking-[-0.015em] truncate">
            {summary}
          </h1>
          {stageLabel && (
            <div className="mt-[3px] font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--fg-muted)]">
              {stageLabel}
            </div>
          )}
        </div>

        <div className="flex items-center gap-[6px] shrink-0">
          {onOpenTerminal && (
            <IconButton tip="terminal" onClick={onOpenTerminal}>
              <Terminal size={13} />
            </IconButton>
          )}
          {onMaximize && (
            <IconButton tip={maximized ? "Restore session list" : "Maximize session view"} onClick={onMaximize}>
              {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </IconButton>
          )}
          {actions && (
            <>
              <span aria-hidden className="w-px h-[18px] bg-[var(--border)] mx-[4px]" />
              {actions}
            </>
          )}
        </div>
      </div>

      {/* ── Meta strip: labeled blocks + stage progress on the right ─── */}
      {(labeled.length > 0 || stageProgress) && (
        <div
          className="px-[18px] py-[8px] flex items-center gap-[14px] flex-wrap border-b border-[var(--border-light)]"
          style={{ background: "rgba(0,0,0,.18)" }}
        >
          {labeled.map((kv, i) => (
            <span
              key={`${kv.k}-${i}`}
              className="inline-flex items-center font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.05em]"
            >
              <span className="text-[var(--fg-faint)] mr-[6px]">{kv.k}</span>
              <b
                className={cn(
                  "font-medium text-[11px] normal-case tracking-normal",
                  kv.error
                    ? "text-[var(--failed)]"
                    : kv.link
                      ? "text-[var(--primary)] cursor-pointer"
                      : "text-[var(--fg)]",
                  kv.mono && "font-[family-name:var(--font-mono)]",
                  !kv.mono && "font-[family-name:var(--font-mono-ui)]",
                )}
              >
                {kv.v}
              </b>
            </span>
          ))}
          {stageProgress && (
            <div data-testid="stage-progress" className="ml-auto inline-flex items-center gap-[6px] shrink-0">
              <span className="text-[11px] font-[family-name:var(--font-mono-ui)] text-[var(--fg-muted)]">
                {stageProgress.completed}/{stageProgress.total} stages
              </span>
              <div className="w-[60px] h-[3px] bg-[var(--border)] rounded-sm overflow-hidden">
                <div
                  className="h-full bg-[var(--primary)] rounded-sm transition-[width] duration-300"
                  style={{ width: stageProgress.pct + "%" }}
                />
              </div>
              <span className="text-[11px] font-[family-name:var(--font-mono-ui)] font-semibold text-[var(--fg)] min-w-[28px] text-right tabular-nums">
                {stageProgress.pct}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IconButton({ tip, onClick, children }: { tip: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tip}
      aria-label={tip}
      className={cn(
        "relative inline-grid place-items-center w-[30px] h-[28px] rounded-[6px] cursor-pointer",
        "bg-[#1e1e30] border border-[var(--border)] text-[var(--fg)]",
        "shadow-[0_1px_2px_rgba(0,0,0,0.2)]",
        "hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] hover:border-[#33334d]",
        "transition-colors duration-[120ms]",
      )}
    >
      {children}
    </button>
  );
}

function getStatusPillStyle(status: SessionStatus) {
  switch (status) {
    case "running":
      return { bg: "rgba(96,165,250,.1)", color: "#7dbbff", border: "rgba(96,165,250,.25)" };
    case "completed":
      return { bg: "rgba(52,211,153,.1)", color: "#34d399", border: "rgba(52,211,153,.25)" };
    case "waiting":
      return { bg: "rgba(251,191,36,.12)", color: "#fbbf24", border: "rgba(251,191,36,.3)" };
    case "failed":
      return { bg: "rgba(248,113,113,.12)", color: "#f87171", border: "rgba(248,113,113,.3)" };
    default:
      return { bg: "rgba(255,255,255,.03)", color: "var(--fg-muted)", border: "var(--border)" };
  }
}
