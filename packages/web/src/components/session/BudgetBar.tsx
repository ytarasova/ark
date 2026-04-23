import { cn } from "../../lib/utils.js";
import { fmtCost } from "../../util.js";

export interface BudgetBarProps {
  /** Running spend in USD. */
  spent: number;
  /** Budget cap in USD. If absent, the bar is not rendered. */
  cap?: number | null;
  className?: string;
}

/**
 * Per-session budget cap bar (Phase 3).
 *
 * Matches the inset progress rail from `/tmp/ark-design-system/preview/cards-session.html`
 * (`.progress` + `.progress .fill`), with an escalating color ramp as
 * spend -> cap: primary < 75%, waiting 75-95%, failed >= 95%.
 */
export function BudgetBar({ spent, cap, className }: BudgetBarProps) {
  if (!cap || cap <= 0) return null;
  const pct = Math.max(0, Math.min(1, spent / cap));
  const warn = pct >= 0.75 && pct < 0.95;
  const over = pct >= 0.95;
  const fill = over
    ? "linear-gradient(90deg, #f87171, #dc2626)"
    : warn
      ? "linear-gradient(90deg, #fbbf24, #f59e0b)"
      : "linear-gradient(90deg, #8b7aff, var(--primary))";
  const labelColor = over ? "text-[var(--failed)]" : warn ? "text-[var(--waiting)]" : "text-[var(--fg-muted)]";
  return (
    <div className={cn("flex flex-col gap-[5px]", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.05em] text-[var(--fg-muted)]">
          Budget
        </span>
        <span className={cn("font-[family-name:var(--font-mono-ui)] text-[11px] tabular-nums", labelColor)}>
          {fmtCost(spent)} / {fmtCost(cap)}
          {over && " — cap exceeded"}
          {warn && " — approaching cap"}
        </span>
      </div>
      <div
        className="relative h-[4px] rounded-full overflow-hidden"
        style={{
          background: "linear-gradient(180deg, rgba(0,0,0,.4), rgba(0,0,0,.2))",
          boxShadow: "inset 0 1px 1px rgba(0,0,0,.5), 0 1px 0 rgba(255,255,255,.03)",
        }}
      >
        <div
          className="absolute top-0 left-0 h-full rounded-full"
          style={{
            width: `${pct * 100}%`,
            background: fill,
            boxShadow: over
              ? "0 0 8px rgba(248,113,113,.6), 0 1px 0 rgba(255,255,255,.15) inset"
              : warn
                ? "0 0 8px rgba(251,191,36,.5), 0 1px 0 rgba(255,255,255,.15) inset"
                : "0 0 8px rgba(107,89,222,.6), 0 1px 0 rgba(255,255,255,.15) inset",
          }}
        />
      </div>
    </div>
  );
}
