import { cn } from "../../lib/utils.js";
import { formatTime } from "./timeline-builder.js";

/**
 * Footer below the Events tab: event count, JSON export button, and
 * timestamp of the most recent event.
 */
export function EventsFooter({
  events,
  sessionId,
  onToast,
}: {
  events: any[];
  sessionId: string;
  onToast: (msg: string, type: string) => void;
}) {
  return (
    <div className="border-t border-[var(--border)] px-6 py-2 shrink-0 bg-[var(--bg)] flex items-center gap-3 text-[11px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]">
      <span>{events.length} events</span>
      <button
        type="button"
        onClick={() => {
          const exportData = events.map((ev: any) => ({
            id: ev.id,
            type: ev.type,
            stage: ev.stage,
            actor: ev.actor,
            data: ev.data,
            created_at: ev.created_at,
          }));
          const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${sessionId}-events.json`;
          a.click();
          URL.revokeObjectURL(url);
          onToast("Events exported", "success");
        }}
        className={cn(
          "px-2 py-0.5 rounded-[var(--radius-sm)] text-[10px] font-medium",
          "border border-[var(--border)] bg-transparent text-[var(--fg-muted)]",
          "hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] transition-colors cursor-pointer",
        )}
      >
        Export JSON
      </button>
      <span className="ml-auto">Last: {formatTime(events[events.length - 1]?.created_at)}</span>
    </div>
  );
}

/** Footer below the Diff tab: aggregated files changed / insertions / deletions. */
export function DiffFooter({ diffData }: { diffData: any }) {
  return (
    <div className="border-t border-[var(--border)] px-6 py-2 shrink-0 bg-[var(--bg)] flex items-center gap-3 text-[11px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]">
      <span>{diffData.filesChanged} files changed</span>
      <span className="text-[var(--diff-add-fg)]">+{diffData.insertions || 0}</span>
      <span className="text-[var(--diff-rm-fg)]">-{diffData.deletions || 0}</span>
    </div>
  );
}

/** Footer below the Todos tab: completed vs. remaining counts. */
export function TodosFooter({ todos }: { todos: any[] }) {
  return (
    <div className="border-t border-[var(--border)] px-6 py-2 shrink-0 bg-[var(--bg)] flex items-center gap-3 text-[11px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]">
      <span>
        {todos.filter((t) => t.done).length} of {todos.length} completed
      </span>
      <span className="ml-auto">{todos.filter((t) => !t.done).length} remaining</span>
    </div>
  );
}
