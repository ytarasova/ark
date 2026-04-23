import { cn } from "../../lib/utils.js";
import type { SessionStatus } from "./StatusDot.js";

/**
 * FilterChip — rebuilt from the `.filter span` rule in app-chrome.html.
 *
 *   font     mono-ui 10px 500 UPPERCASE tracking 0.04em
 *   padding  3px 7px
 *   radius   full (99px)
 *   default  fg-muted on transparent
 *   on       primary-subtle bg + primary fg
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
      {label ?? status ?? ""}
      {count != null && <span className="ml-1 opacity-80 tabular-nums">{count}</span>}
    </>
  );
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 px-[7px] py-[3px] rounded-full",
        "font-[family-name:var(--font-mono-ui)] text-[10px] font-medium tracking-[0.04em] uppercase leading-[1.2]",
        "border-0 bg-transparent cursor-pointer transition-colors duration-150",
        "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[rgba(255,255,255,0.03)]",
        active && "bg-[var(--primary-subtle)] text-[var(--primary)]",
        className,
      )}
      aria-pressed={active}
      {...props}
    >
      {content}
    </button>
  );
}
