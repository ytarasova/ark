import { cn } from "../../lib/utils.js";
import { type SessionStatus } from "./StatusDot.js";
import { RuntimeChip, AgentChip, ComputeChip } from "./badge.js";
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
  /** Breadcrumb segments (e.g. ["ark", "sessions"]). Last segment is auto-current. */
  breadcrumb?: string[];
  /** Meta strip KV rows (runtime, branch, agent, flow, stage, etc). */
  kvs?: SessionHeaderKv[];
  /** Runtime name (claude|codex|gemini|goose). Renders as a RuntimeChip. */
  runtime?: string;
  /** Agent name. Renders as an AgentChip. */
  agent?: string;
  /** Compute target (local, ec2, k8s…). Renders as a ComputeChip. */
  compute?: string;
  /** Optional stage text shown next to the status pill ("running · implement"). */
  stageLabel?: string;
  /** Ticker values (tokens, spend, elapsed). */
  tickers?: { label: string; value: string; bump?: boolean }[];
  /** Action buttons. */
  actions?: React.ReactNode;
  onCopyId?: () => void;
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
 * `/tmp/ark-design-system/preview/chrome-session-header.html` +
 * `/tmp/ark-design-system/preview/app-chrome.html` (main-hd + sub-hd).
 *
 * Rows:
 *   main-hd   44px, breadcrumb (mono-ui 11px) + status pill (pulsing) + ticker + icon btns.
 *   sub-hd    title h1 17px sans 600 tracking -0.015em + kv-row (mono 11px).
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
  cost,
  className,
  ...props
}: SessionHeaderProps) {
  const crumbs = breadcrumb ?? ["ark", "sessions"];
  const statusMeta = getStatusPillStyle(status);
  return (
    <div
      className={cn(
        "shrink-0 flex flex-col border-b border-[var(--border)] bg-[var(--bg)]",
        className,
      )}
      {...props}
    >
      {/* ── Breadcrumb + status + ticker row (44px) ─────────────────── */}
      <div className="h-[44px] px-[18px] flex items-center gap-[10px]">
        <div className="font-[family-name:var(--font-mono-ui)] text-[11px] font-normal text-[var(--fg-muted)] flex items-center gap-[6px]">
          {crumbs.map((c, i) => (
            <span key={`${c}-${i}`} className="flex items-center gap-[6px]">
              <span className={cn(i === crumbs.length - 1 && "text-[var(--fg)]")}>{c}</span>
              {i < crumbs.length - 1 && <span className="opacity-40">/</span>}
            </span>
          ))}
          <span className="opacity-40">/</span>
          <button
            type="button"
            onClick={onCopyId}
            title="Click to copy id"
            className={cn(
              "text-[var(--fg)] cursor-pointer bg-transparent border-0 p-0",
              "hover:text-[var(--primary)] transition-colors",
            )}
          >
            {sessionId}
          </button>
        </div>

        <span
          className={cn(
            "inline-flex items-center gap-[5px] px-[9px] py-[3px] rounded-full shrink-0",
            "font-[family-name:var(--font-mono-ui)] text-[10px] font-semibold tracking-[0.06em] uppercase",
            "border",
          )}
          style={{
            background: statusMeta.bg,
            color: statusMeta.color,
            borderColor: statusMeta.border,
          }}
        >
          <i
            aria-hidden
            className="w-[5px] h-[5px] rounded-full"
            style={{
              background: "currentColor",
              boxShadow: "0 0 6px currentColor",
              animation: status === "running" ? "chipPulse 1.4s ease-in-out infinite" : undefined,
            }}
          />
          {stageLabel ?? status}
        </span>

        <span className="flex-1" />

        {tickers && tickers.length > 0 && (
          <div className="flex items-center gap-[12px] font-[family-name:var(--font-mono-ui)] text-[10px] font-medium text-[var(--fg-muted)] uppercase tracking-[0.04em]">
            {tickers.map((t, i) => (
              <span key={i}>
                <span
                  className={cn(
                    "text-[var(--fg)] tabular-nums font-semibold",
                    t.bump && "animate-[chipPulse_1.8s_ease-in-out_infinite]",
                  )}
                >
                  {t.value}
                </span>
                {t.label && <span className="ml-1">{t.label}</span>}
              </span>
            ))}
          </div>
        )}
        {!tickers && cost && (
          <span className="font-[family-name:var(--font-mono-ui)] text-[12px] font-medium text-[var(--primary)] tabular-nums">
            {cost}
          </span>
        )}

        {actions && <div className="flex items-center gap-[6px] shrink-0">{actions}</div>}
      </div>

      {/* ── Title + KV row ──────────────────────────────────────────── */}
      <div className="px-[18px] pt-[10px] pb-[12px] flex flex-col gap-[10px]">
        <h1 className="m-0 font-[family-name:var(--font-sans)] text-[17px] leading-[1.25] font-semibold text-[var(--fg)] tracking-[-0.015em] truncate">
          {summary}
        </h1>
        <div className="flex gap-[18px] font-[family-name:var(--font-mono-ui)] text-[11px] font-normal flex-wrap items-center">
          {runtime && (
            <span className="inline-flex items-center gap-[6px] text-[var(--fg-muted)]">
              runtime <RuntimeChip>{runtime}</RuntimeChip>
            </span>
          )}
          {agent && (
            <span className="inline-flex items-center gap-[6px] text-[var(--fg-muted)]">
              agent <AgentChip>{agent}</AgentChip>
            </span>
          )}
          {compute && (
            <span className="inline-flex items-center gap-[6px] text-[var(--fg-muted)]">
              compute <ComputeChip>{compute}</ComputeChip>
            </span>
          )}
          {kvs?.map((kv, i) => (
            <span key={`${kv.k}-${i}`} className="inline-flex gap-[6px] items-center text-[var(--fg-muted)]">
              <span>{kv.k}</span>
              <b
                className={cn(
                  "font-medium",
                  kv.error ? "text-[var(--failed)]" : "text-[var(--fg)]",
                  kv.link && "text-[var(--primary)] cursor-pointer",
                  kv.mono && "font-[family-name:var(--font-mono)]",
                )}
              >
                {kv.v}
              </b>
            </span>
          ))}
        </div>
      </div>
    </div>
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
