import { useState } from "react";
import { X, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils.js";

export interface ToolCallFailedProps extends React.ComponentProps<"div"> {
  icon?: React.ReactNode;
  label: string;
  duration?: string;
  error?: string;
  detail?: React.ReactNode;
}

/**
 * Red-tinted failed tool call with error details.
 */
export function ToolCallFailed({ icon, label, duration, error, detail, className, ...props }: ToolCallFailedProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn("my-[3px]", className)} {...props}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex items-center gap-2 w-full text-left px-2 py-[5px] rounded-[var(--radius-sm)]",
          "font-[family-name:var(--font-mono)] text-[12px] text-[var(--fg-muted)] cursor-pointer",
          "bg-[var(--diff-rm-bg)] border border-[var(--failed)]/15",
          "hover:bg-[var(--diff-rm-bg)] transition-colors duration-150",
        )}
      >
        <span className="text-[var(--fg-muted)] w-3.5 shrink-0 inline-flex items-center justify-center">
          {icon ?? (expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />)}
        </span>
        <span className="flex-1 truncate">{label}</span>
        {duration && (
          <span className="text-[10px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)] tabular-nums">
            {duration}
          </span>
        )}
        <X size={11} className="text-[var(--failed)]" />
      </button>
      {error && (
        <div
          className={cn(
            "px-2 py-1.5 pl-[22px] font-[family-name:var(--font-mono)] text-[11px]",
            "text-[var(--failed)] bg-[var(--diff-rm-bg)] rounded-b-[var(--radius-sm)] leading-[1.5]",
          )}
        >
          {error}
        </div>
      )}
      {expanded && detail && (
        <div className="pl-[22px] pr-2 py-1 text-[12px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)] leading-[1.6]">
          {detail}
        </div>
      )}
    </div>
  );
}
