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
   * When provided, the card is expandable and reveals this payload in the
   * body. Prompt-shaped string fields (task_preview, prompt, message,
   * summary, task) are pulled out and rendered as preformatted text with
   * real line breaks; the remaining keys fall through to pretty-printed
   * JSON. Accepts any event-like object; the render guards against nulls +
   * circular refs.
   */
  details?: unknown;
  className?: string;
}

/** Keys that typically hold prompt-shaped multi-line text. When present on
 *  the details payload, we render them as `<pre>` blocks with real newlines
 *  rather than leaving them to JSON.stringify, which would escape each `\n`
 *  as the literal two chars `\` + `n`. See issue #417. */
const PROMPT_TEXT_KEYS = ["task_preview", "prompt", "message", "summary", "task"] as const;

/**
 * Inline system-event card for the session timeline.
 *
 * Matches the tool-block visual shell (bordered card, mono-ui header) so
 * stage transitions / handoffs / PR events read as proper widgets rather
 * than `--- divider ---` text. Collapsed by default; clicking the header
 * toggles the body when `details` is provided. Without `details` the card
 * renders as a non-interactive single-line summary.
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
      {open && hasDetails && <EventDetailsBody details={details} />}
    </div>
  );
}

/** Render the expanded details body. Prompt-shaped string fields render as
 *  preformatted text (real newlines, word-wrap) so users can read the
 *  prompt instead of squinting at JSON-escaped `\n`. Everything else falls
 *  through to pretty-printed JSON. */
function EventDetailsBody({ details }: { details: unknown }) {
  const { promptFields, rest } = splitPromptFields(details);

  if (promptFields.length === 0) {
    return (
      <pre
        className={cn(
          "px-[11px] py-[9px] bg-[var(--bg-code)] overflow-auto max-h-[260px]",
          "font-[family-name:var(--font-mono)] text-[11px] leading-[1.55] text-[var(--fg-muted)]",
          "whitespace-pre-wrap break-words",
        )}
      >
        {safeStringify(details)}
      </pre>
    );
  }

  const hasRest = rest !== null && Object.keys(rest).length > 0;
  return (
    <div className="bg-[var(--bg-code)] overflow-auto max-h-[260px]">
      {promptFields.map(([key, value]) => (
        <div key={key} className="px-[11px] py-[9px] border-b border-[var(--border)] last:border-b-0">
          <div className="font-[family-name:var(--font-mono-ui)] text-[10px] uppercase tracking-wide text-[var(--fg-faint)] mb-[4px]">
            {key}
          </div>
          <pre
            className={cn(
              "font-[family-name:var(--font-mono)] text-[11px] leading-[1.55] text-[var(--fg-muted)]",
              "whitespace-pre-wrap break-words m-0",
            )}
          >
            {value}
          </pre>
        </div>
      ))}
      {hasRest && (
        <pre
          className={cn(
            "px-[11px] py-[9px]",
            "font-[family-name:var(--font-mono)] text-[11px] leading-[1.55] text-[var(--fg-muted)]",
            "whitespace-pre-wrap break-words m-0",
          )}
        >
          {safeStringify(rest)}
        </pre>
      )}
    </div>
  );
}

/** Split a details payload into prompt-shaped string fields and everything
 *  else. Non-object / nullish inputs pass through as "everything else" so
 *  the caller can render them as JSON. Keys not in `PROMPT_TEXT_KEYS`, and
 *  keys whose value isn't a non-empty string, stay in `rest`. */
export function splitPromptFields(details: unknown): {
  promptFields: Array<[string, string]>;
  rest: Record<string, unknown> | null;
} {
  if (details === null || typeof details !== "object") {
    return { promptFields: [], rest: null };
  }
  const promptFields: Array<[string, string]> = [];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (PROMPT_TEXT_KEYS.includes(key as (typeof PROMPT_TEXT_KEYS)[number]) && typeof value === "string" && value) {
      promptFields.push([key, value]);
    } else {
      rest[key] = value;
    }
  }
  return { promptFields, rest };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
