import { ErrorRow } from "../ErrorRow.js";
import type { ErrorInfo } from "../types.js";
import { formatTime } from "../timeline-builder.js";

interface ErrorsTabProps {
  session: any;
  errorEvents: any[];
  onSelectError: (err: ErrorInfo) => void;
}

/**
 * Errors tab body. Merges session-level errors (from a failed status) with
 * discrete error events recorded on the timeline; each row opens the error
 * detail drawer when clicked.
 */
export function ErrorsTab({ session, errorEvents, onSelectError }: ErrorsTabProps) {
  return (
    <div className="max-w-[800px] mx-auto flex flex-col">
      {session.status === "failed" && session.error && (
        <ErrorRow
          type="Session Failed"
          message={session.error.length > 100 ? session.error.slice(0, 100) + "..." : session.error}
          stage={session.stage}
          detail={session.error}
          onSelect={() =>
            onSelectError({
              type: "Session Failed",
              message: session.error,
              stage: session.stage,
              detail: session.error,
              agent: session.agent,
            })
          }
        />
      )}
      {errorEvents.map((ev: any, i: number) => (
        <ErrorRow
          key={ev.id || i}
          type={ev.type}
          message={ev.data?.error || ev.data?.message}
          stage={ev.stage}
          timestamp={formatTime(ev.created_at)}
          detail={ev.data?.error || ev.data?.message || JSON.stringify(ev.data, null, 2)}
          onSelect={() =>
            onSelectError({
              type: ev.type,
              message: ev.data?.error || ev.data?.message,
              stage: ev.stage,
              timestamp: formatTime(ev.created_at),
              detail: ev.data?.error || ev.data?.message || JSON.stringify(ev.data, null, 2),
              agent: ev.data?.agent || ev.actor,
            })
          }
        />
      ))}
      {!session.error && errorEvents.length === 0 && (
        <div className="text-center py-12 text-[var(--fg-faint)]">No errors</div>
      )}
    </div>
  );
}
