import { ErrorRow } from "../ErrorRow.js";
import { formatTime } from "../timeline-builder.js";

interface ErrorsTabProps {
  session: any;
  errorEvents: any[];
}

/**
 * Errors tab body. Merges session-level errors (from a failed status) with
 * discrete error events recorded on the timeline. Rows fold detail in/out
 * inline -- same UX as session timeline tool blocks (no drawer).
 */
export function ErrorsTab({ session, errorEvents }: ErrorsTabProps) {
  return (
    <div className="max-w-[800px] mx-auto flex flex-col">
      {session.status === "failed" && session.error && (
        <ErrorRow
          type="Session Failed"
          message={session.error.length > 100 ? session.error.slice(0, 100) + "..." : session.error}
          stage={session.stage}
          detail={session.error}
          agent={session.agent}
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
          agent={ev.data?.agent || ev.actor}
        />
      ))}
      {!session.error && errorEvents.length === 0 && (
        <div className="text-center py-12 text-[var(--fg-faint)]">No errors</div>
      )}
    </div>
  );
}
