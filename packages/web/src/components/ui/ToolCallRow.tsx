import { useState } from "react";
import { Check, X, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils.js";

export interface ToolCallRowProps extends React.ComponentProps<"div"> {
  icon?: React.ReactNode;
  label: string;
  duration?: string;
  status?: "running" | "done" | "error";
  detail?: React.ReactNode;
}

/**
 * Expandable tool call row in the conversation view.
 * Shows icon, description, timing, and success/fail status.
 */
export function ToolCallRow({ icon, label, duration, status = "done", detail, className, ...props }: ToolCallRowProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn("my-[3px]", className)} {...props}>
      <button
        type="button"
        onClick={() => detail && setExpanded((v) => !v)}
        className={cn(
          "flex items-center gap-2 w-full text-left px-2 py-[5px] rounded-[var(--radius-sm)]",
          "font-[family-name:var(--font-mono)] text-[12px] text-[var(--fg-muted)] cursor-pointer",
          "hover:bg-[var(--bg-hover)] transition-colors duration-150",
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
        {status === "done" && <Check size={11} className="text-[var(--running)]" />}
        {status === "running" && <span className="text-[11px] text-[var(--primary)]">...</span>}
        {status === "error" && <X size={11} className="text-[var(--failed)]" />}
      </button>
      {expanded && detail && (
        <div className="pl-[22px] pr-2 py-1 text-[12px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)] leading-[1.6]">
          {detail}
        </div>
      )}
    </div>
  );
}
