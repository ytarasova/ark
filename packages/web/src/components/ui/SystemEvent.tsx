import { cn } from "../../lib/utils.js";

export interface SystemEventProps extends React.ComponentProps<"div"> {
  children: React.ReactNode;
}

/**
 * Centered divider with horizontal rules for stage transitions
 * and system events in the conversation view.
 *
 * Example: "-- plan completed --"
 */
export function SystemEvent({ children, className, ...props }: SystemEventProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 my-5 text-[var(--fg-muted)] text-[11px] font-medium",
        "before:content-[''] before:flex-1 before:h-px before:bg-[var(--border)]",
        "after:content-[''] after:flex-1 after:h-px after:bg-[var(--border)]",
        className,
      )}
      {...props}
    >
      <span className="whitespace-nowrap">{children}</span>
    </div>
  );
}
