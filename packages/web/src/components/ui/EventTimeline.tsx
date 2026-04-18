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
  /** Original event type string for display in the drawer. */
  eventType?: string;
}

export interface EventTimelineProps extends React.ComponentProps<"div"> {
  events: TimelineEvent[];
  onStageClick?: (stage: string) => void;
  onEventSelect?: (event: TimelineEvent) => void;
}

const BORDER_CLASSES: Record<EventColor, string> = {
  green: "border-l-[var(--completed)]",
  blue: "border-l-[var(--running)]",
  red: "border-l-[var(--failed)]",
  amber: "border-l-[var(--waiting)]",
  gray: "border-l-[var(--stopped)]",
};

/**
 * Clean list-style event timeline with colored left borders.
 * Clicking a row calls onEventSelect to open a detail drawer.
 */
export function EventTimeline({ events, onStageClick, onEventSelect, className, ...props }: EventTimelineProps) {
  if (events.length === 0) {
    return <div className="text-center text-sm text-[var(--fg-muted)] py-12">No events recorded for this session.</div>;
  }

  return (
    <div className={cn("flex flex-col max-w-[800px] mx-auto", className)} {...props}>
      {events.map((event) => {
        const hasStage = !!(event.stage && onStageClick);

        return (
          <div
            key={event.id}
            className={cn("group border-l-2", BORDER_CLASSES[event.color], "border-b border-b-[var(--border)]")}
          >
            <div
              className="flex items-center gap-2 py-2 px-3 cursor-pointer hover:bg-[var(--bg-hover)]"
              onClick={() => onEventSelect?.(event)}
            >
              {/* Label - main content */}
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <div className="text-[12px] leading-[1.5] flex-1 min-w-0 truncate">{event.label}</div>

                {/* Stage badge */}
                {event.stage && (
                  <span
                    className={cn(
                      "shrink-0 text-[10px] font-[family-name:var(--font-mono-ui)] px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-hover)] text-[var(--fg-muted)]",
                      hasStage && "cursor-pointer hover:text-[var(--primary)] hover:bg-[var(--primary)]/10",
                    )}
                    onClick={
                      hasStage
                        ? (e) => {
                            e.stopPropagation();
                            onStageClick!(event.stage!);
                          }
                        : undefined
                    }
                  >
                    {event.stage}
                  </span>
                )}
              </div>

              {/* Timestamp - right aligned, muted */}
              <span className="shrink-0 text-[10px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)] tabular-nums">
                {event.timestamp}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
