import { cn } from "../../lib/utils.js";

export interface CostWidgetProps {
  tokensIn?: number | null;
  tokensOut?: number | null;
  toolCalls?: number;
  modelLabel?: string;
  live?: boolean;
}

function fmtK(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Cost widget -- stacked under the Flow widget in the session detail right rail.
 * Matches the user-07-desired-detail-body reference:
 *
 *   header  mono-ui 10px UPPERCASE COST + right-aligned LIVE chip (running only)
 *   body    two columns TOKENS IN / TOKENS OUT with 17px sans 600 numbers
 *   footer  `{model}` + right-aligned `{n} tool calls` mono-ui 11px fg-muted
 */
export function CostWidget({ tokensIn, tokensOut, toolCalls, modelLabel, live }: CostWidgetProps) {
  return (
    <div
      className="rounded-[9px] border border-[var(--border)] border-t-[rgba(255,255,255,0.07)] border-b-[rgba(0,0,0,0.5)] px-[14px] py-[12px]"
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,.025) 0%, rgba(255,255,255,0) 25%, rgba(0,0,0,.15) 100%), var(--bg-card)",
      }}
    >
      <div className="flex items-center justify-between mb-[10px] font-[family-name:var(--font-mono-ui)] text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
        <span>COST</span>
        {live && (
          <span className="inline-flex items-center gap-[5px] font-[family-name:var(--font-mono-ui)] text-[10px] font-semibold uppercase tracking-[0.08em] text-[#7dbbff]">
            <i
              aria-hidden
              className="w-[6px] h-[6px] rounded-full bg-[var(--running)]"
              style={{
                boxShadow: "0 0 6px currentColor",
                animation: "chipPulse 1.6s ease-in-out infinite",
              }}
            />
            LIVE
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-[10px] mb-[10px]">
        <div>
          <div className="font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--fg-faint)] mb-[2px]">
            TOKENS IN
          </div>
          <div className="font-[family-name:var(--font-sans)] text-[17px] leading-[1.2] font-semibold text-[var(--fg)] tabular-nums tracking-[-0.015em]">
            {fmtK(tokensIn)}
          </div>
        </div>
        <div>
          <div className="font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--fg-faint)] mb-[2px]">
            TOKENS OUT
          </div>
          <div className="font-[family-name:var(--font-sans)] text-[17px] leading-[1.2] font-semibold text-[var(--fg)] tabular-nums tracking-[-0.015em]">
            {fmtK(tokensOut)}
          </div>
        </div>
      </div>

      <div
        className={cn(
          "flex items-center justify-between pt-[8px] border-t border-[var(--border-light)]",
          "font-[family-name:var(--font-mono-ui)] text-[11px] text-[var(--fg-muted)]",
        )}
      >
        <span className="truncate min-w-0">{modelLabel || ""}</span>
        {toolCalls != null && toolCalls >= 0 && (
          <span className="shrink-0 tabular-nums">
            {toolCalls} tool call{toolCalls === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  );
}
