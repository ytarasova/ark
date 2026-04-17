import { cn } from "../../lib/utils.js";
import type { SessionStatus } from "./StatusDot.js";

export interface FilterChipProps extends React.ComponentProps<"button"> {
  status: SessionStatus;
  count: number;
  active?: boolean;
}

const STATUS_ACTIVE_CLASSES: Record<SessionStatus, string> = {
  running: "border-transparent bg-[rgba(52,211,153,0.12)] text-[var(--running)]",
  waiting: "border-transparent bg-[rgba(251,191,36,0.12)] text-[var(--waiting)]",
  completed: "border-transparent bg-[rgba(96,165,250,0.12)] text-[var(--completed)]",
  failed: "border-transparent bg-[rgba(248,113,113,0.12)] text-[var(--failed)]",
  stopped: "border-transparent bg-[var(--bg-hover)] text-[var(--fg-muted)]",
  pending: "border-transparent bg-[var(--bg-hover)] text-[var(--fg-muted)]",
};

export function FilterChip({ status, count, active = false, className, ...props }: FilterChipProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 h-[22px] px-2 rounded-full text-[11px] font-medium",
        "border border-[var(--border)] bg-transparent text-[var(--fg-muted)] cursor-pointer",
        "hover:bg-[var(--bg-hover)] transition-colors duration-150",
        "font-[var(--font-sans)]",
        active && STATUS_ACTIVE_CLASSES[status],
        className,
      )}
      {...props}
    >
      {count} {status}
    </button>
  );
}
