import { cn } from "../../lib/utils.js";

/**
 * CostBarChart -- per /tmp/ark-design-system/preview/stats-chart.html
 *
 * Raised outer card (same skin as KpiCard). Inner sunken `well` holds the
 * bars: purple gradient (#8b7aff -> var(--primary) -> #5a48c9), 2px rounded
 * top corners, faint bottom, tiny dot on top of the peak (today) bar.
 *
 * X-axis day labels below, today label highlighted.
 *
 * Data model: simple array of { day, value } points. The max value anchors
 * 100% of well height. Today (last item) gets the `peak` treatment.
 */

export interface CostBarPoint {
  day: string; // "M", "T", "W"... or full "Mon"
  value: number; // e.g. dollar amount
  /** Override label text -- e.g. "Today". */
  label?: string;
  /** Highlight this bar (defaults to last). */
  peak?: boolean;
}

export interface CostBarChartProps {
  title?: string;
  today?: string; // rendered in header-right, e.g. "$47.82"
  todaySuffix?: string; // "today"
  points: CostBarPoint[];
  className?: string;
}

export function CostBarChart({
  title = "Cost · last 14 days",
  today,
  todaySuffix = "today",
  points,
  className,
}: CostBarChartProps) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const lastIdx = points.length - 1;
  return (
    <div
      className={cn(
        "relative rounded-[9px] border border-[var(--border)] border-t-[rgba(255,255,255,0.08)] border-b-[rgba(0,0,0,0.5)]",
        "px-[14px] pt-[12px] pb-[10px]",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-1px_0_rgba(0,0,0,0.4),0_1px_2px_rgba(0,0,0,0.45),0_10px_22px_-6px_rgba(0,0,0,0.4)]",
        className,
      )}
      style={{
        backgroundImage:
          "linear-gradient(180deg, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0) 25%, rgba(0,0,0,0.15) 100%)",
        backgroundColor: "var(--bg-card)",
      }}
    >
      <div className="flex justify-between items-baseline mb-[10px]">
        <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.05em] text-[var(--fg-muted)]">
          {title}
        </span>
        {today && (
          <span className="font-[family-name:var(--font-sans)] text-[13px] font-semibold text-[var(--fg)] tabular-nums tracking-[-0.01em]">
            {today}{" "}
            <em className="text-[var(--fg-faint)] not-italic font-normal text-[11px] ml-[4px] font-[family-name:var(--font-mono-ui)]">
              {todaySuffix}
            </em>
          </span>
        )}
      </div>

      {/* sunken well */}
      <div
        className={cn(
          "relative h-[92px] rounded-[6px] overflow-hidden px-[4px] py-[6px]",
          "shadow-[inset_0_2px_4px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.03)]",
        )}
        style={{ backgroundImage: "linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.1) 100%)" }}
      >
        {/* faint grid lines at 25/50/75% */}
        <span
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              "linear-gradient(180deg, transparent 24%, rgba(255,255,255,.02) 25%, transparent 26%, transparent 49%, rgba(255,255,255,.02) 50%, transparent 51%, transparent 74%, rgba(255,255,255,.02) 75%, transparent 76%)",
          }}
        />
        <div className="flex gap-[4px] items-end h-full relative z-[1]">
          {points.map((p, i) => {
            const pct = Math.max(2, Math.round((p.value / max) * 100));
            const peak = p.peak ?? i === lastIdx;
            return (
              <div
                key={i}
                className={cn(
                  "flex-1 rounded-t-[2px] relative",
                  peak
                    ? "bg-[linear-gradient(180deg,#a78bfa_0%,#8b7aff_60%,var(--primary)_100%)] shadow-[inset_0_-1px_0_rgba(255,255,255,0.25),0_1px_1px_rgba(0,0,0,0.4),0_0_14px_rgba(167,139,250,0.5)] opacity-100"
                    : "bg-[linear-gradient(180deg,#8b7aff_0%,var(--primary)_60%,#5a48c9_100%)] shadow-[inset_0_-1px_0_rgba(255,255,255,0.15),0_1px_1px_rgba(0,0,0,0.4),0_0_8px_rgba(107,89,222,0.2)] opacity-90",
                )}
                style={{ height: `${pct}%` }}
                title={`${p.day}: ${p.value}`}
              >
                {peak && (
                  <span
                    aria-hidden
                    className="absolute left-1/2 -translate-x-1/2 w-[4px] h-[4px] rounded-full bg-[#a78bfa] shadow-[0_0_8px_#a78bfa]"
                    style={{ top: -5 }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex gap-[4px] mt-[5px] font-[family-name:var(--font-mono-ui)] text-[9px] font-medium tracking-[0.05em] text-[var(--fg-faint)]">
        {points.map((p, i) => (
          <span key={i} className={cn("flex-1 text-center", (i === lastIdx || p.peak) && "text-[var(--fg)]")}>
            {p.label ?? p.day}
          </span>
        ))}
      </div>
    </div>
  );
}
