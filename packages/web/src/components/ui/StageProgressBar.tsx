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
          className={cn("h-[3px] flex-1 rounded-full", {
            "bg-[var(--running)]": s.state === "done",
            "bg-[var(--primary)]": s.state === "active",
            "bg-[var(--border)]": s.state === "pending",
          })}
          title={`${s.name}: ${s.state}`}
        />
      ))}
    </div>
  );
}
