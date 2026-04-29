import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils.js";
import type { ErrorInfo } from "./types.js";

/**
 * A single row in the session Errors tab. Clicking the row folds the
 * detail body in/out inline -- same pattern as session timeline tool
 * blocks. No drawer; everything stays on the page.
 */
export function ErrorRow({ type, message, stage, timestamp, detail, agent }: ErrorInfo) {
  const [open, setOpen] = useState(false);
  const hasBody = !!(detail || agent);

  return (
    <div className="border-l-2 border-l-[var(--failed)] border-b border-b-[var(--border)]">
      <button
        type="button"
        onClick={() => hasBody && setOpen((prev) => !prev)}
        aria-expanded={hasBody ? open : undefined}
        className={cn(
          "w-full flex items-center gap-2 py-2 px-3 text-left bg-transparent border-0",
          hasBody ? "cursor-pointer hover:bg-[var(--bg-hover)]" : "cursor-default",
        )}
      >
        {hasBody && (
          <span className="shrink-0 text-[var(--fg-muted)]">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-[12px] font-semibold text-[var(--fg)] shrink-0">{type}</span>
          {message && <span className="text-[12px] text-[var(--fg-muted)] truncate min-w-0">{message}</span>}
          {stage && (
            <span className="shrink-0 text-[10px] font-[family-name:var(--font-mono-ui)] px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-hover)] text-[var(--fg-muted)]">
              {stage}
            </span>
          )}
        </div>
        {timestamp && (
          <span className="shrink-0 text-[10px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)] tabular-nums">
            {timestamp}
          </span>
        )}
      </button>

      {open && hasBody && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-3 bg-[var(--bg)]">
          {agent && (
            <div className="grid grid-cols-[90px_1fr] gap-y-1 gap-x-3 text-[11px]">
              <span className="text-[var(--fg-muted)]">Agent</span>
              <span className="font-[family-name:var(--font-mono-ui)] text-[var(--fg)]">{agent}</span>
            </div>
          )}
          {detail && (
            <pre
              className={cn(
                "rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border)] p-3",
                "text-[11px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)] leading-[1.7]",
                "whitespace-pre-wrap break-words overflow-auto max-h-[400px]",
              )}
            >
              {detail}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
