import { cn } from "../../lib/utils.js";

export interface StageProgress {
  /** Stage name */
  name: string;
  /** "done" | "active" | "pending" */
  state: "done" | "active" | "pending";
}

export interface StageProgressBarProps extends React.ComponentProps<"div"> {
  stages: StageProgress[];
}

/**
 * Mini horizontal pipeline bar for session list items.
 * Each stage is a 3px-tall bar segment colored by state.
 */
export function StageProgressBar({ stages, className, ...props }: StageProgressBarProps) {
  return (
    <div className={cn("flex gap-0.5 flex-1", className)} {...props}>
      {stages.map((s) => (
        <div
          key={s.name}
          className={cn("h-[3px] flex-1 rounded-full overflow-hidden relative", {
            "bg-[var(--completed)]": s.state === "done",
            "bg-[var(--primary)]": s.state === "active",
            "bg-[var(--border)]": s.state === "pending",
          })}
          title={`${s.name}: ${s.state}`}
        >
          {s.state === "active" && (
            <div className="absolute inset-0 bg-[var(--border)] rounded-full">
              <div
                className="h-full w-[40%] bg-[var(--primary)] rounded-full"
                style={{ animation: "indeterminate 1.5s ease-in-out infinite" }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
