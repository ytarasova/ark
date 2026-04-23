import { cn } from "../../lib/utils.js";
import type { SessionStatus } from "./StatusDot.js";

export interface StageProgress {
  /** Stage name */
  name: string;
  /** State machine: done | active | pending | failed | stopped */
  state: "done" | "active" | "pending" | "failed" | "stopped";
}

export interface StageProgressBarProps extends React.ComponentProps<"div"> {
  stages: StageProgress[];
}

/**
 * Segmented pipeline bar -- one 3px-tall segment per stage, colored by state.
 * The active stage gets a shimmer sweep (keyframes `ark-shimmer-sweep` in
 * styles.css).
 *
 * This is the "tick-strip" variant used inside session list rows to convey
 * the shape of the pipeline. The single-lane variant (a percent-based fill
 * with a shimmer) lives as `SessionLane` below.
 */
export function StageProgressBar({ stages, className, ...props }: StageProgressBarProps) {
  return (
    <div className={cn("flex gap-0.5 flex-1", className)} {...props}>
      {stages.map((s) => (
        <div
          key={s.name}
          className={cn("h-[3px] flex-1 rounded-full overflow-hidden relative", {
            "bg-[var(--completed)]": s.state === "done",
            "bg-[var(--running)]": s.state === "active",
            "bg-[var(--failed)]": s.state === "failed",
            "bg-[var(--fg-muted)] opacity-60": s.state === "stopped",
            "bg-[var(--border)]": s.state === "pending",
          })}
          title={`${s.name}: ${s.state}`}
        >
          {s.state === "active" && (
            <div
              className="absolute top-0 h-full w-[30%]"
              style={{
                background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)",
                animation: "slideRight 1.6s linear infinite",
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Single-lane progress bar (`.lane` in app-chrome.html / cards-session.html).
 *
 * Geometry:    h 3px   radius full   inset dark track
 * Running fill linear-gradient(90deg, #60a5fa, #a78bfa) + 1.8s shimmer sweep
 * Done    fill solid var(--completed)
 * Failed  fill solid var(--failed)
 * Waiting fill solid var(--waiting)
 */
export interface SessionLaneProps extends React.ComponentProps<"div"> {
  /** 0..1 progress. For running/waiting we still honour percent; done = 1. */
  percent: number;
  status: SessionStatus;
}

export function SessionLane({ percent, status, className, ...props }: SessionLaneProps) {
  const pct = Math.max(0, Math.min(1, percent));
  const isRunning = status === "running";
  const fillBg =
    status === "running"
      ? "linear-gradient(90deg, #60a5fa, #a78bfa)"
      : status === "completed"
        ? "var(--completed)"
        : status === "failed"
          ? "var(--failed)"
          : status === "waiting"
            ? "var(--waiting)"
            : "var(--border)";
  return (
    <div className={cn("relative h-[3px] rounded-full overflow-hidden", "bg-[var(--border)]", className)} {...props}>
      <div
        className="relative h-full rounded-full overflow-hidden"
        style={{ width: `${pct * 100}%`, background: fillBg }}
      >
        {isRunning && (
          <span
            aria-hidden
            className="absolute inset-0"
            style={{
              background: "linear-gradient(90deg, transparent, rgba(255,255,255,.5), transparent)",
              animation: "laneShimmer 1.8s ease-in-out infinite",
            }}
          />
        )}
      </div>
    </div>
  );
}
