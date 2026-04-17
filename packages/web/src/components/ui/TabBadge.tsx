import { cn } from "../../lib/utils.js";

export interface TabBadgeProps extends React.ComponentProps<"span"> {
  /** Whether the parent tab is active */
  active?: boolean;
}

/**
 * Count badge shown next to tab labels, e.g. "Events 24" or "Diff +42/-8".
 */
export function TabBadge({ active = false, className, children, ...props }: TabBadgeProps) {
  return (
    <span
      className={cn(
        "text-[10px] font-medium px-[5px] py-[1px] rounded-[3px]",
        active ? "bg-[var(--primary-subtle)] text-[var(--primary)]" : "bg-[var(--border)] text-[var(--fg-muted)]",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
