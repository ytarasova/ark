import { cn } from "../../lib/utils.js";

export interface ScrollProgressProps extends React.ComponentProps<"div"> {
  /** 0-100 percent scrolled */
  progress: number;
}

/**
 * 2px accent bar showing scroll position at the top of a scrollable area.
 */
export function ScrollProgress({ progress, className, ...props }: ScrollProgressProps) {
  return (
    <div className={cn("h-[2px] w-full bg-transparent shrink-0 relative", className)} {...props}>
      <div
        className="h-full bg-[var(--primary)] rounded-r-[1px] transition-[width] duration-100"
        style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
      />
    </div>
  );
}
