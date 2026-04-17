import { useState } from "react";
import { cn } from "../../lib/utils.js";

export type EventColor = "green" | "blue" | "red" | "amber" | "gray";

export interface TimelineEvent {
  id: string;
  timestamp: string;
  label: React.ReactNode;
  color: EventColor;
  detail?: string;
  rawData?: Record<string, unknown>;
  stage?: string;
}

export interface EventTimelineProps extends React.ComponentProps<"div"> {
  events: TimelineEvent[];
  onStageClick?: (stage: string) => void;
}

const DOT_CLASSES: Record<EventColor, string> = {
  green: "bg-[var(--running)]",
  blue: "bg-[var(--completed)]",
  red: "bg-[var(--failed)]",
  amber: "bg-[var(--waiting)]",
  gray: "bg-[var(--stopped)]",
};

/**
 * Rich event timeline with expandable detail rows and colored status dots.
 */
export function EventTimeline({ events, onStageClick, className, ...props }: EventTimelineProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (events.length === 0) {
    return <div className="text-center text-sm text-[var(--fg-muted)] py-12">No events recorded for this session.</div>;
  }

  return (
    <div className={cn("flex flex-col gap-0 max-w-[800px] mx-auto", className)} {...props}>
      {events.map((event) => {
        const isExpanded = expanded.has(event.id);
        const hasExpandable = !!(event.detail || event.rawData);
        const hasStage = !!(event.stage && onStageClick);

        return (
          <div key={event.id} className="group">
            <div
              className={cn(
                "flex items-start gap-3 py-2 px-2 rounded-[var(--radius-sm)]",
                hasExpandable && "cursor-pointer hover:bg-[var(--bg-hover)]",
              )}
              onClick={hasExpandable ? () => toggle(event.id) : undefined}
            >
              {/* Timestamp */}
              <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--fg-muted)] w-[52px] shrink-0 pt-[3px] text-right tabular-nums">
                {event.timestamp}
              </span>

              {/* Colored dot */}
              <span className={cn("w-[7px] h-[7px] rounded-full shrink-0 mt-[5px]", DOT_CLASSES[event.color])} />

              {/* Label */}
              <div className="flex-1 min-w-0 flex items-start gap-2">
                <div className="text-[12px] leading-[1.6] flex-1 min-w-0">{event.label}</div>

                {/* Stage filter button */}
                {hasStage && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStageClick!(event.stage!);
                    }}
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-[var(--primary)] hover:underline cursor-pointer"
                  >
                    filter
                  </button>
                )}

                {/* Expand indicator */}
                {hasExpandable && (
                  <span className="shrink-0 text-[10px] text-[var(--fg-muted)] pt-0.5 select-none">
                    {isExpanded ? "\u25BC" : "\u25B6"}
                  </span>
                )}
              </div>
            </div>

            {/* Expanded detail */}
            {isExpanded && hasExpandable && (
              <div className="ml-[82px] mr-2 mb-2 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border)] p-3 text-[11px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)] leading-[1.7] overflow-auto max-h-[300px]">
                {event.detail && <div className="whitespace-pre-wrap mb-2">{event.detail}</div>}
                {event.rawData && (
                  <pre className="whitespace-pre-wrap break-all">{JSON.stringify(event.rawData, null, 2)}</pre>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
