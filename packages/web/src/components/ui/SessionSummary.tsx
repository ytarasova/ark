import { cn } from "../../lib/utils.js";

export interface SessionSummaryProps extends React.ComponentProps<"div"> {
  duration: string;
  cost: string;
  filesChanged: number;
  testsPassed?: number;
  prLink?: { href: string; label: string };
}

/**
 * Bordered card showing session completion summary:
 * duration, cost, files changed, tests passed, and optional PR link.
 */
export function SessionSummary({
  duration,
  cost,
  filesChanged,
  testsPassed,
  prLink,
  className,
  ...props
}: SessionSummaryProps) {
  return (
    <div
      className={cn(
        "max-w-[720px] mx-auto mt-6 border border-[var(--border)] rounded-lg",
        "bg-[var(--bg-card)] px-5 py-4 shadow-[0_2px_8px_rgba(0,0,0,0.15)]",
        className,
      )}
      {...props}
    >
      <h4 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--fg-muted)] mb-3">
        Session Summary
      </h4>
      <div className="grid grid-cols-4 gap-4">
        <SummaryStat label="Duration" value={duration} />
        <SummaryStat label="Cost" value={cost} valueClass="text-[var(--primary)]" />
        <SummaryStat label="Files" value={String(filesChanged)} />
        {testsPassed != null && (
          <SummaryStat label="Tests" value={`${testsPassed} passed`} valueClass="text-[var(--running)]" />
        )}
      </div>
      {prLink && (
        <a
          href={prLink.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "mt-3 pt-3 border-t border-[var(--border)] flex items-center gap-1.5",
            "text-[12px] text-[var(--primary)] hover:underline",
          )}
        >
          &rarr; {prLink.label}
        </a>
      )}
    </div>
  );
}

function SummaryStat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-[var(--fg-muted)] uppercase tracking-[0.04em]">{label}</span>
      <span className={cn("text-[16px] font-semibold font-[family-name:var(--font-mono-ui)]", valueClass)}>
        {value}
      </span>
    </div>
  );
}
