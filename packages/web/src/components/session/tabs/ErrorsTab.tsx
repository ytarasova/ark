import { ErrorRow } from "../ErrorRow.js";
import { formatTime } from "../timeline-builder.js";

interface ErrorsTabProps {
  session: any;
  errorEvents: any[];
}

/**
 * Find the long-form `dispatch_failed` event payload that pairs with the
 * session-level `session.error` truncation. When the dispatcher fails it
 * persists the truncated reason on `session.error` AND a structured
 * payload (errorChain, requestUrl, attempts, ...) on the matching event;
 * surface the full payload here so the operator can debug without
 * spelunking ark.jsonl.
 */
function findDispatchFailedDetail(errorEvents: any[]): string | null {
  for (let i = errorEvents.length - 1; i >= 0; i--) {
    const ev = errorEvents[i];
    if (ev.type !== "dispatch_failed" || !ev.data) continue;
    const lines: string[] = [];
    if (ev.data.reason) lines.push(`reason: ${ev.data.reason}`);
    if (ev.data.requestMethod && ev.data.requestUrl) {
      lines.push(`request: ${ev.data.requestMethod} ${ev.data.requestUrl}`);
    }
    if (typeof ev.data.attempts === "number") lines.push(`attempts: ${ev.data.attempts}`);
    if (ev.data.fromStage || ev.data.toStage) {
      lines.push(`stage: ${ev.data.fromStage ?? "?"} -> ${ev.data.toStage ?? "?"}`);
    }
    if (Array.isArray(ev.data.errorChain) && ev.data.errorChain.length > 0) {
      lines.push("\nerror chain:");
      for (const link of ev.data.errorChain) {
        lines.push(`  ${link.name ?? "Error"}: ${link.message ?? ""}`);
        if (link.stack) lines.push(link.stack.split("\n").map((s: string) => "    " + s).join("\n"));
      }
    }
    return lines.join("\n");
  }
  return null;
}

/**
 * Errors tab body. Merges session-level errors (from a failed status) with
 * discrete error events recorded on the timeline. Rows fold detail in/out
 * inline -- same UX as session timeline tool blocks (no drawer).
 */
export function ErrorsTab({ session, errorEvents }: ErrorsTabProps) {
  const dispatchDetail = findDispatchFailedDetail(errorEvents);
  return (
    <div className="max-w-[800px] mx-auto flex flex-col">
      {session.status === "failed" && session.error && (
        <ErrorRow
          type="Session Failed"
          message={session.error.length > 100 ? session.error.slice(0, 100) + "..." : session.error}
          stage={session.stage}
          detail={dispatchDetail ?? session.error}
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
