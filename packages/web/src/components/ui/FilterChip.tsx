import { cn } from "../../lib/utils.js";
import type { SessionStatus } from "./StatusDot.js";

/**
 * FilterChip — rebuilt from the `.filter span` rule in app-chrome.html and
 * tightened per the session-list filter-row UX nit:
 *
 *   font     mono-ui 10px 500 UPPERCASE tracking 0.05em
 *   padding  3px 6px
 *   radius   full (99px)
 *   default  fg-muted on transparent + 1px hairline border so chips read
 *            as discrete pills instead of two stacked text fragments
 *   on       primary-subtle bg + primary fg + matching primary border
 *
 * The label and the count live inline (gap of one thin space) on the same
 * baseline; we no longer rely on separator characters between chips.
 */
export interface FilterChipProps extends React.ComponentProps<"button"> {
  status?: SessionStatus;
  count?: number;
  label?: string;
  active?: boolean;
}

export function FilterChip({ status, count, label, active = false, className, children, ...props }: FilterChipProps) {
  const content = children ?? (
    <>
      <span>{label ?? status ?? ""}</span>
      {count != null && <span className="opacity-80 tabular-nums">{count}</span>}
    </>
  );
  return (
    <button
      type="button"
      data-active={active ? "true" : "false"}
      className={cn(
        "inline-flex items-baseline gap-[4px] px-[6px] py-[3px] rounded-full whitespace-nowrap",
        "font-[family-name:var(--font-mono-ui)] text-[10px] font-medium tracking-[0.05em] uppercase leading-[1.2]",
        "border cursor-pointer transition-colors duration-150",
        active
          ? "bg-[var(--primary-subtle)] text-[var(--primary)] border-[var(--primary-subtle)]"
          : "bg-transparent border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[rgba(255,255,255,0.03)]",
        className,
      )}
      aria-pressed={active}
      {...props}
    >
      {content}
    </button>
  );
}
