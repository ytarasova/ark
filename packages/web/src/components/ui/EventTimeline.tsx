import { cn } from "../../lib/utils.js";
import type { SessionStatus } from "./StatusDot.js";

export interface TimelineEvent {
  id: string;
  timestamp: string;
  label: string;
  status?: SessionStatus;
  detail?: string;
}

export interface EventTimelineProps extends React.ComponentProps<"div"> {
  events: TimelineEvent[];
}

const STATUS_DOT_CLASSES: Record<SessionStatus, string> = {
  running: "bg-[var(--running)]",
  waiting: "bg-[var(--waiting)]",
  completed: "bg-[var(--completed)]",
  failed: "bg-[var(--failed)]",
  stopped: "bg-[var(--stopped)]",
  pending: "bg-[var(--stopped)] opacity-60",
};

/**
 * Timestamped event list with colored dots.
 */
export function EventTimeline({ events, className, ...props }: EventTimelineProps) {
  return (
    <div className={cn("flex flex-col gap-0", className)} {...props}>
      {events.map((event) => (
        <div key={event.id} className="flex items-start gap-3 py-2 px-1">
          <span className="font-[family-name:var(--font-mono-ui)] text-[10px] text-[var(--fg-muted)] w-16 shrink-0 pt-0.5 text-right">
            {event.timestamp}
          </span>
          <span
            className={cn(
              "w-[7px] h-[7px] rounded-full shrink-0 mt-[5px]",
              STATUS_DOT_CLASSES[event.status ?? "completed"],
            )}
          />
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-medium">{event.label}</div>
            {event.detail && <div className="text-[11px] text-[var(--fg-muted)] mt-0.5">{event.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
