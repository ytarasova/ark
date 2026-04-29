import { useState } from "react";
import { ChevronRight, Info } from "lucide-react";
import { cn } from "../../lib/utils.js";

export interface SystemEventProps {
  children: React.ReactNode;
  /** Optional timestamp, shown on the right of the header. */
  timestamp?: string;
  /** Optional stage tag, shown as a small pill next to the label. */
  stage?: string;
  /**
   * When provided, the card is expandable and reveals this payload pretty-
   * printed as JSON in the body. Accepts any event-like object; the render
   * guards against nulls + circular refs.
   */
  details?: unknown;
  className?: string;
}

/**
 * Inline system-event card for the session timeline.
 *
 * Matches the tool-block visual shell (bordered card, mono-ui header) so
 * stage transitions / handoffs / PR events read as proper widgets rather
 * than `--- divider ---` text. Collapsed by default; clicking the header
 * toggles the JSON body when `details` is provided. Without `details` the
 * card renders as a non-interactive single-line summary.
 */
export function SystemEvent({ children, timestamp, stage, details, className }: SystemEventProps) {
  const [open, setOpen] = useState(false);
  const hasDetails = details !== undefined && details !== null;

  const headerContent = (
    <>
      {hasDetails && (
        <ChevronRight
          size={12}
          strokeWidth={2}
          aria-hidden
          className={cn("text-[var(--fg-muted)] shrink-0 transition-transform duration-[120ms]", open && "rotate-90")}
        />
      )}
      <Info size={12} strokeWidth={1.75} aria-hidden className="text-[var(--fg-muted)] shrink-0" />
      <span className="flex-1 min-w-0 truncate font-[family-name:var(--font-mono-ui)] text-[11px] text-[var(--fg)]">
        {children}
      </span>
      {stage && (
        <span className="shrink-0 text-[10px] font-[family-name:var(--font-mono-ui)] px-[5px] py-[1px] rounded-[var(--radius-sm)] bg-[var(--bg-hover)] text-[var(--fg-muted)]">
          {stage}
        </span>
      )}
      {timestamp && (
        <span className="shrink-0 font-[family-name:var(--font-mono-ui)] text-[10px] text-[var(--fg-faint)] tabular-nums">
          {timestamp}
        </span>
      )}
    </>
  );

  return (
    <div
      className={cn(
        "my-[6px] rounded-[7px] overflow-hidden",
        "border border-[var(--border)] bg-[var(--bg-card)]",
        "shadow-[0_1px_2px_rgba(0,0,0,0.3)]",
        className,
      )}
    >
      {hasDetails ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "w-full flex items-center gap-[8px] px-[11px] py-[7px] text-left",
            "bg-[rgba(0,0,0,0.18)] border-0 cursor-pointer",
            "hover:bg-[rgba(0,0,0,0.28)] transition-colors",
            open && "border-b border-[var(--border)]",
          )}
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex items-center gap-[8px] px-[11px] py-[7px] bg-[rgba(0,0,0,0.18)]">{headerContent}</div>
      )}
      {open && hasDetails && (
        <pre
          className={cn(
            "px-[11px] py-[9px] bg-[var(--bg-code)] overflow-auto max-h-[260px]",
            "font-[family-name:var(--font-mono)] text-[11px] leading-[1.55] text-[var(--fg-muted)]",
            "whitespace-pre-wrap break-words",
          )}
        >
          {safeStringify(details)}
        </pre>
      )}
    </div>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
