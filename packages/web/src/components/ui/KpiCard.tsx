import { cn } from "../../lib/utils.js";

/**
 * KPI card -- per /tmp/ark-design-system/preview/stats-chart.html
 *
 *   Raised slab (light top edge, dark bottom), subtle gradient, radius 8.
 *   Top: 5px colored pip + mono-ui uppercase label.
 *   Middle: big 20px semibold tabular-nums value.
 *   Bottom: optional delta with ▲/▼ arrow, green (up) / red (down).
 */

export type KpiColor = "primary" | "blue" | "amber" | "green" | "red";

const PIP_COLORS: Record<KpiColor, { bg: string; glow: string }> = {
  primary: { bg: "var(--primary)", glow: "rgba(107,89,222,0.6)" },
  blue: { bg: "#60a5fa", glow: "rgba(96,165,250,0.6)" },
  amber: { bg: "#fbbf24", glow: "rgba(251,191,36,0.6)" },
  green: { bg: "#34d399", glow: "rgba(52,211,153,0.6)" },
  red: { bg: "#f87171", glow: "rgba(248,113,113,0.6)" },
};

export interface KpiCardProps {
  label: string;
  value: React.ReactNode;
  color?: KpiColor;
  delta?: React.ReactNode;
  /** `up` (green) | `down` (red) | default uses value as-is */
  deltaDir?: "up" | "down" | "neutral";
  /** Direction the arrow points. `up`/`down`; omit to hide. */
  deltaArrow?: "up" | "down";
  className?: string;
}

export function KpiCard({ label, value, color = "primary", delta, deltaDir, deltaArrow, className }: KpiCardProps) {
  const pip = PIP_COLORS[color];
  const arrow = deltaArrow === "up" ? "▲" : deltaArrow === "down" ? "▼" : null;
  return (
    <div
      className={cn(
        "relative flex flex-col gap-[3px]",
        "rounded-[8px] border border-[var(--border)] border-t-[rgba(255,255,255,0.08)] border-b-[rgba(0,0,0,0.5)]",
        "px-[12px] py-[10px]",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-1px_0_rgba(0,0,0,0.4),0_1px_2px_rgba(0,0,0,0.45),0_6px_14px_-4px_rgba(0,0,0,0.4)]",
        className,
      )}
      style={{
        backgroundImage:
          "linear-gradient(180deg, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0) 30%, rgba(0,0,0,0.15) 100%)",
        backgroundColor: "var(--bg-card)",
      }}
    >
      <span className="inline-flex items-center gap-[5px] font-[family-name:var(--font-mono-ui)] text-[9.5px] font-medium uppercase tracking-[0.06em] text-[var(--fg-muted)]">
        <i
          aria-hidden
          className="inline-block w-[5px] h-[5px] rounded-full"
          style={{ backgroundColor: pip.bg, boxShadow: `0 0 5px ${pip.glow}` }}
        />
        {label}
      </span>
      <span className="font-[family-name:var(--font-sans)] text-[20px] font-semibold leading-[1.2] tracking-[-0.015em] text-[var(--fg)] tabular-nums [text-shadow:_0_1px_0_rgba(0,0,0,0.4)]">
        {value}
      </span>
      {delta && (
        <span
          className={cn(
            "inline-flex items-center gap-[4px] font-[family-name:var(--font-mono-ui)] text-[10px] font-medium tabular-nums",
            deltaDir === "down"
              ? "text-[#f87171]"
              : deltaDir === "neutral"
                ? "text-[var(--fg-muted)]"
                : "text-[#34d399]",
          )}
        >
          {arrow && <span className="text-[9px] opacity-85">{arrow}</span>}
          {delta}
        </span>
      )}
    </div>
  );
}
