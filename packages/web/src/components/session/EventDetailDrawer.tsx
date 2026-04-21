import { DetailDrawer } from "../ui/DetailDrawer.js";
import type { TimelineEvent } from "../ui/EventTimeline.js";

/**
 * Side drawer that shows the full payload for a timeline event picked from
 * the Events tab. Rendered regardless of selection; the drawer handles its
 * own open/closed state via `open`.
 */
export function EventDetailDrawer({ event, onClose }: { event: TimelineEvent | null; onClose: () => void }) {
  return (
    <DetailDrawer open={!!event} onClose={onClose} title="Event Detail">
      {event && (
        <div className="flex flex-col gap-4">
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">Type</span>
            <div className="mt-1 text-[13px] font-semibold text-[var(--fg)]">{event.eventType || event.id}</div>
          </div>

          {event.stage && (
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
                Stage
              </span>
              <div className="mt-1">
                <span className="text-[11px] font-[family-name:var(--font-mono-ui)] px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-hover)] text-[var(--fg-muted)]">
                  {event.stage}
                </span>
              </div>
            </div>
          )}

          <div>
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
              Timestamp
            </span>
            <div className="mt-1 text-[12px] font-[family-name:var(--font-mono-ui)] text-[var(--fg)]">
              {event.timestamp}
            </div>
          </div>

          {event.detail && (
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
                Detail
              </span>
              <pre className="mt-1 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border)] p-3 text-[11px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)] leading-[1.7] whitespace-pre-wrap break-words overflow-auto max-h-[300px]">
                {event.detail}
              </pre>
            </div>
          )}

          {event.rawData && (
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
                Raw Data
              </span>
              <pre className="mt-1 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border)] p-3 text-[11px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)] leading-[1.7] whitespace-pre-wrap break-all overflow-auto max-h-[400px]">
                {JSON.stringify(event.rawData, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </DetailDrawer>
  );
}
