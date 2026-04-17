import { cn } from "../../lib/utils.js";
import type { StageProgress } from "./StageProgressBar.js";

export interface StagePipelineProps extends React.ComponentProps<"div"> {
  stages: StageProgress[];
}

/**
 * Horizontal text pipeline: plan > implement > verify > review > merge
 * Each stage label is color-coded by its state.
 */
export function StagePipeline({ stages, className, ...props }: StagePipelineProps) {
  return (
    <div className={cn("flex items-center shrink-0", className)} {...props}>
      {stages.map((s, i) => (
        <span key={s.name} className="flex items-center">
          <span
            className={cn("text-[11px] font-medium px-2 py-[3px] rounded tracking-[0.02em]", {
              "text-[var(--running)]": s.state === "done",
              "text-[var(--primary)] bg-[var(--primary-subtle)]": s.state === "active",
              "text-[var(--fg-muted)]": s.state === "pending",
            })}
          >
            {s.name}
          </span>
          {i < stages.length - 1 && (
            <span className="text-[var(--fg-muted)] text-[10px] px-[1px]" aria-hidden>
              &gt;
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
