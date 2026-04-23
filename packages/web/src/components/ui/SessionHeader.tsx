import { Copy, Terminal } from "lucide-react";
import { cn } from "../../lib/utils.js";
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
  /** Legacy: cost chip (tokens / $). If given but no `tickers`, rendered on the right. */
  cost?: string;
}

/**
 * Session detail header -- rebuilt from
 * `/tmp/ark-design-system/preview/chrome-session-header.html`.
 *
 * Two rows (tabs live in <ContentTabs> below):
 *   1. top-row  (padding 14px 16px 12px): breadcrumb + copyable id, title
 *               (17px/600/-0.015em), action icons + primary/secondary btns.
 *   2. meta-row (padding 8px 16px, bg rgba(0,0,0,.18)): animated status pill,
 *               LABELed blocks (flow / agent / compute / branch), right-aligned
 *               stats (tokens · $ · runtime).
 */
export function SessionHeader({
  sessionId,
  summary,
  status,
  breadcrumb,
  kvs,
  runtime,
  agent,
  compute,
  stageLabel,
  tickers,
  actions,
  onCopyId,
  onOpenTerminal,
  cost,
  className,
  ...props
}: SessionHeaderProps) {
  const crumbs = breadcrumb ?? ["ark", "sessions"];
  const statusMeta = getStatusPillStyle(status);
  const isRunning = status === "running";

  // Additional labeled blocks derived from runtime/agent/compute props + kvs.
  const labeled: { k: string; v: React.ReactNode; mono?: boolean; link?: boolean; error?: boolean }[] = [];
  if (runtime) labeled.push({ k: "runtime", v: runtime });
  if (agent) labeled.push({ k: "agent", v: agent });
  if (compute) labeled.push({ k: "compute", v: compute });
  if (kvs && kvs.length > 0) labeled.push(...kvs);

  return (
    <div className={cn("shrink-0 flex flex-col border-b border-[var(--border)] bg-[var(--bg)]", className)} {...props}>
      {/* ── Top row: breadcrumb+id, title, action buttons ─────────── */}
      <div className="px-[16px] pt-[14px] pb-[12px] flex items-center gap-[16px] border-b border-[var(--border-light)]">
        <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
          <div className="flex items-center gap-[6px] font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--fg-faint)]">
            {crumbs.map((c, i) => (
              <span key={`${c}-${i}`} className="flex items-center gap-[6px]">
                <span className="hover:text-[var(--fg-muted)] transition-colors">{c}</span>
                <span className="opacity-50">/</span>
              </span>
            ))}
            <button
              type="button"
              onClick={onCopyId}
              title="Click to copy id"
              className="bg-transparent border-0 p-0 text-[var(--fg-muted)] hover:text-[var(--primary)] transition-colors cursor-pointer font-[family-name:var(--font-mono)] text-[10px] normal-case tracking-[0.02em]"
            >
              {sessionId}
            </button>
          </div>
          <h1 className="m-0 font-[family-name:var(--font-sans)] text-[17px] leading-[1.25] font-semibold text-[var(--fg)] tracking-[-0.015em] truncate">
            {summary}
          </h1>
        </div>

        <div className="flex items-center gap-[6px] shrink-0">
          {onCopyId && (
            <IconButton tip="copy id" onClick={onCopyId}>
              <Copy size={13} />
            </IconButton>
          )}
          {onOpenTerminal && (
            <IconButton tip="terminal" onClick={onOpenTerminal}>
              <Terminal size={13} />
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

      {/* ── Meta strip: status pill · labeled blocks · stats ──────── */}
      <div
        className="px-[16px] py-[8px] flex items-center gap-[14px] flex-wrap border-b border-[var(--border-light)]"
        style={{ background: "rgba(0,0,0,.18)" }}
      >
        <span
          className="inline-flex items-center gap-[6px] px-[9px] py-[3px] rounded-full shrink-0 border font-[family-name:var(--font-mono-ui)] text-[10px] font-semibold uppercase tracking-[0.06em]"
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
          {stageLabel ?? status}
        </span>

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

        <span className="flex-1" />

        {tickers && tickers.length > 0 && (
          <span className="inline-flex items-center gap-[6px] font-[family-name:var(--font-mono)] text-[11px] font-normal text-[var(--fg)] tabular-nums normal-case tracking-normal">
            {tickers.map((t, i) => (
              <span key={i} className="inline-flex items-center gap-[4px]">
                {i > 0 && (
                  <span aria-hidden className="opacity-40">
                    ·
                  </span>
                )}
                <span className={cn(t.bump && isRunning && "bump")}>{t.value}</span>
                {t.label && <span className="text-[var(--fg-muted)]">{t.label}</span>}
              </span>
            ))}
          </span>
        )}
        {!tickers && cost && (
          <span className="font-[family-name:var(--font-mono)] text-[11px] font-normal text-[var(--fg)] tabular-nums">
            {cost}
          </span>
        )}
      </div>
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
