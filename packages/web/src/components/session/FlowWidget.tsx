import { cn } from "../../lib/utils.js";
import type { StageProgress } from "../ui/StageProgressBar.js";

export interface FlowWidgetProps {
  stages: StageProgress[];
  /** Optional per-stage duration text (e.g. "00:14", "02:47"). Indexed by stage name. */
  durations?: Record<string, string>;
}

/**
 * Flow widget -- stacked under the Cost widget in the session detail right rail.
 * Matches the user-07-desired-detail-body reference:
 *
 *   header     mono-ui 10px UPPERCASE fg-muted, right-aligned `n/N` count
 *   row        8px dot + stage name (sans 12.5px) + right-aligned time (mono-ui 10px)
 *                 done     green dot, fg text
 *                 active   pulsing blue dot, fg text, live mm:ss
 *                 pending  faint dot, fg-faint text, "queued" label
 *                 failed   red dot + fg text
 */
export function FlowWidget({ stages, durations }: FlowWidgetProps) {
  if (!stages || stages.length === 0) return null;
  const total = stages.length;
  const done = stages.filter((s) => s.state === "done").length;
  const activeIdx = stages.findIndex((s) => s.state === "active");
  const counted = activeIdx >= 0 ? activeIdx + 1 : done;

  return (
    <div
      className="rounded-[9px] border border-[var(--border)] border-t-[rgba(255,255,255,0.07)] border-b-[rgba(0,0,0,0.5)] px-[14px] py-[12px]"
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,.025) 0%, rgba(255,255,255,0) 25%, rgba(0,0,0,.15) 100%), var(--bg-card)",
      }}
    >
      <div className="flex items-center justify-between mb-[9px] font-[family-name:var(--font-mono-ui)] text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
        <span>FLOW</span>
        <span className="tabular-nums text-[var(--fg)]">
          {counted}/{total}
        </span>
      </div>
      <ul className="m-0 p-0 list-none flex flex-col gap-[6px]">
        {stages.map((s) => {
          const time = durations?.[s.name];
          const isActive = s.state === "active";
          const isDone = s.state === "done";
          const isFailed = s.state === "failed";
          const isPending = s.state === "pending" || s.state === "stopped";

          const dotColor = isDone
            ? "bg-[var(--completed)]"
            : isActive
              ? "bg-[var(--running)] shadow-[var(--running-glow)]"
              : isFailed
                ? "bg-[var(--failed)] shadow-[var(--failed-glow)]"
                : "bg-[var(--stopped)] opacity-60";

          return (
            <li key={s.name} className="flex items-center gap-[9px]">
              <span aria-hidden className={cn("relative w-[8px] h-[8px] rounded-full shrink-0", dotColor)}>
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute rounded-full border-[1.5px] border-[var(--running)] opacity-40"
                    style={{ inset: -3, animation: "pulse 1.6s ease-out infinite" }}
                  />
                )}
              </span>
              <span
                className={cn(
                  "flex-1 min-w-0 truncate font-[family-name:var(--font-sans)] text-[12.5px] tracking-[-0.005em]",
                  isPending ? "text-[var(--fg-faint)]" : "text-[var(--fg)]",
                  isActive && "font-semibold",
                )}
              >
                {s.name}
              </span>
              <span
                className={cn(
                  "font-[family-name:var(--font-mono-ui)] text-[10px] tabular-nums shrink-0",
                  isPending ? "text-[var(--fg-faint)]" : "text-[var(--fg-muted)]",
                )}
              >
                {time ?? (isPending ? "queued" : isActive ? "--:--" : "")}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
