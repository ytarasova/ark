import { cn } from "../../lib/utils.js";

export interface ScrollProgressProps extends React.ComponentProps<"div"> {
  /** 0-100 percent scrolled */
  progress: number;
}

/**
 * 2px accent bar showing scroll position at the top of a scrollable area.
 *
 * Positioned absolutely so it overlays the top edge instead of consuming
 * 2px of vertical space -- otherwise the right-panel header sits 2px
 * below the left-panel header, breaking horizontal alignment of the two
 * 44px header strips. Caller is expected to render this inside a
 * `position: relative` parent (the SessionDetail root provides one).
 */
export function ScrollProgress({ progress, className, ...props }: ScrollProgressProps) {
  return (
    <div
      className={cn("absolute top-0 left-0 right-0 h-[2px] bg-transparent z-10 pointer-events-none", className)}
      {...props}
    >
      <div
        className="h-full bg-[var(--primary)] rounded-r-[1px] transition-[width] duration-100"
        style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
      />
    </div>
  );
}
