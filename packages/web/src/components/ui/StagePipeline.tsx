import { cn } from "../../lib/utils.js";
import type { StageProgress } from "./StageProgressBar.js";

export interface StagePipelineProps extends React.ComponentProps<"div"> {
  stages: StageProgress[];
  /** Currently selected stage filter (null = show all) */
  selectedStage?: string | null;
  /** Called when a stage label is clicked */
  onStageClick?: (stageName: string) => void;
}

/**
 * Horizontal text pipeline: plan > implement > verify > review > merge
 * Each stage label is color-coded by its state and clickable for filtering.
 */
export function StagePipeline({ stages, selectedStage, onStageClick, className, ...props }: StagePipelineProps) {
  return (
    <div className={cn("flex items-center shrink-0", className)} {...props}>
      {selectedStage && onStageClick && (
        <button
          type="button"
          onClick={() => onStageClick(selectedStage)}
          className={cn(
            "text-[10px] font-medium mr-1.5 px-0 py-0",
            "text-[var(--fg-muted)] hover:underline hover:text-[var(--fg)] transition-colors cursor-pointer",
            "bg-transparent border-none",
          )}
        >
          All
        </button>
      )}
      {stages.map((s, i) => (
        <span key={s.name} className="flex items-center">
          <button
            type="button"
            onClick={() => onStageClick?.(s.name)}
            className={cn(
              "text-[11px] font-medium px-2 py-[3px] rounded tracking-[0.02em] transition-colors cursor-pointer",
              "bg-transparent border-none",
              {
                "text-[var(--completed)]": s.state === "done" && selectedStage !== s.name,
                "text-[var(--primary)] bg-[var(--primary-subtle)]": s.state === "active" && selectedStage !== s.name,
                "text-[var(--failed)]": s.state === "failed" && selectedStage !== s.name,
                "text-[var(--fg-muted)] line-through decoration-dashed":
                  s.state === "stopped" && selectedStage !== s.name,
                "text-[var(--fg-muted)]": s.state === "pending" && selectedStage !== s.name,
                "text-[var(--primary)] underline underline-offset-4 decoration-2 decoration-[var(--primary)]":
                  selectedStage === s.name,
              },
              "hover:text-[var(--primary)]",
            )}
          >
            {s.name}
          </button>
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
