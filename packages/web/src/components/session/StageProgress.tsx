/**
 * Secondary header row that sits below the main `SessionHeader`, showing
 * the agent + flow name on the left and a compact X-of-Y stage progress
 * bar on the right.
 */
export function StageProgress({
  agent,
  flow,
  completedStages,
  totalStages,
  progressPct,
}: {
  agent?: string | null;
  flow?: string | null;
  completedStages: number;
  totalStages: number;
  progressPct: number;
}) {
  return (
    <div className="h-10 border-b border-[var(--border)] flex items-center px-5 gap-2.5 shrink-0">
      <span className="text-[11px] font-[family-name:var(--font-mono-ui)] text-[var(--fg-muted)]">{agent || "--"}</span>
      {flow && (
        <>
          <div className="w-px h-[18px] bg-[var(--border)]" />
          <span className="text-[11px] font-[family-name:var(--font-mono-ui)] text-[var(--fg-muted)]">{flow}</span>
        </>
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[11px] font-[family-name:var(--font-mono-ui)] text-[var(--fg-muted)]">
          {completedStages}/{totalStages} stages
        </span>
        <div className="w-[60px] h-[3px] bg-[var(--border)] rounded-sm overflow-hidden">
          <div
            className="h-full bg-[var(--primary)] rounded-sm transition-[width] duration-300"
            style={{ width: progressPct + "%" }}
          />
        </div>
        <span className="text-[11px] font-[family-name:var(--font-mono-ui)] font-semibold text-[var(--fg)] min-w-[28px] text-right">
          {progressPct}%
        </span>
      </div>
    </div>
  );
}
