import { DetailDrawer } from "../ui/DetailDrawer.js";
import type { ErrorInfo } from "./types.js";

/**
 * Side drawer that shows the full stage/agent/timestamp + detail body of an
 * error picked from the Errors tab.
 */
export function ErrorDetailDrawer({ error, onClose }: { error: ErrorInfo | null; onClose: () => void }) {
  return (
    <DetailDrawer open={!!error} onClose={onClose} title="Error Detail">
      {error && (
        <div className="flex flex-col gap-4">
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">Type</span>
            <div className="mt-1 text-[13px] font-semibold text-[var(--failed)]">{error.type}</div>
          </div>

          {(error.stage || error.agent) && (
            <div className="grid grid-cols-[90px_1fr] gap-y-2 gap-x-3 text-[12px]">
              {error.stage && (
                <>
                  <span className="text-[var(--fg-muted)]">Stage</span>
                  <span className="font-[family-name:var(--font-mono-ui)] text-[var(--fg)]">{error.stage}</span>
                </>
              )}
              {error.agent && (
                <>
                  <span className="text-[var(--fg-muted)]">Agent</span>
                  <span className="font-[family-name:var(--font-mono-ui)] text-[var(--fg)]">{error.agent}</span>
                </>
              )}
              {error.timestamp && (
                <>
                  <span className="text-[var(--fg-muted)]">Time</span>
                  <span className="font-[family-name:var(--font-mono-ui)] text-[var(--fg)]">{error.timestamp}</span>
                </>
              )}
            </div>
          )}

          {error.detail && (
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
                Error Message
              </span>
              <pre className="mt-1 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border)] p-3 text-[11px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)] leading-[1.7] whitespace-pre-wrap break-words overflow-auto max-h-[400px]">
                {error.detail}
              </pre>
            </div>
          )}
        </div>
      )}
    </DetailDrawer>
  );
}
