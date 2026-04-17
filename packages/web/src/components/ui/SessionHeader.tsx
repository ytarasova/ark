import { cn } from "../../lib/utils.js";
import { StatusDot, type SessionStatus } from "./StatusDot.js";
import { StagePipeline } from "./StagePipeline.js";
import type { StageProgress } from "./StageProgressBar.js";

export interface SessionHeaderProps extends React.ComponentProps<"div"> {
  sessionId: string;
  summary: string;
  status: SessionStatus;
  stages: StageProgress[];
  cost?: string;
  /** Action buttons (Stop, Dispatch, etc.) */
  actions?: React.ReactNode;
  onCopyId?: () => void;
}

/**
 * Top bar with session title, stage pipeline indicator, integration pills,
 * cost, and action buttons.
 */
export function SessionHeader({
  sessionId,
  summary,
  status,
  stages,
  cost,
  actions,
  onCopyId,
  className,
  ...props
}: SessionHeaderProps) {
  return (
    <div
      className={cn("h-12 border-b border-[var(--border)] flex items-center px-5 gap-3 shrink-0", className)}
      {...props}
    >
      <StatusDot status={status} size="lg" />

      <button
        type="button"
        onClick={onCopyId}
        className={cn(
          "font-[family-name:var(--font-mono-ui)] text-[12px] text-[var(--fg-muted)]",
          "cursor-pointer hover:text-[var(--primary)] transition-colors duration-150",
          "bg-transparent border-none p-0",
        )}
        title="Click to copy"
      >
        {sessionId}
      </button>

      <span className="text-[14px] font-medium truncate min-w-0">{summary}</span>

      <StagePipeline stages={stages} className="ml-auto" />

      {cost && (
        <span className="font-[family-name:var(--font-mono-ui)] text-[12px] font-medium text-[var(--primary)] shrink-0 px-2">
          {cost}
        </span>
      )}

      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
