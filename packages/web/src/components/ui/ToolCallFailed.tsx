import { useState } from "react";
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
          "bg-[var(--diff-rm-bg)] border border-[rgba(248,113,113,0.15)]",
          "hover:bg-[rgba(248,113,113,0.12)] transition-colors duration-150",
        )}
      >
        <span className="text-[10px] text-[var(--fg-muted)] w-3.5 text-center shrink-0">
          {icon ?? (expanded ? "\u25BC" : "\u25B6")}
        </span>
        <span className="flex-1 truncate">{label}</span>
        {duration && (
          <span className="text-[10px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]">{duration}</span>
        )}
        <span className="text-[11px] text-[var(--failed)]">&#10007;</span>
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
