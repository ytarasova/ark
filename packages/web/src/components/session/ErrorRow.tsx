import type { ErrorInfo } from "./types.js";

/**
 * A single row in the session Errors tab. Clicking the row opens the detail
 * drawer with the full error payload.
 */
export function ErrorRow({ type, message, stage, timestamp, onSelect }: ErrorInfo & { onSelect?: () => void }) {
  return (
    <div className="border-l-2 border-l-[var(--failed)] border-b border-b-[var(--border)]">
      <div className="flex items-center gap-2 py-2 px-3 cursor-pointer hover:bg-[var(--bg-hover)]" onClick={onSelect}>
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
      </div>
    </div>
  );
}
