/**
 * Secondary header row that sits below the main `SessionHeader`, showing
 * a compact X-of-Y stage progress bar.
 *
 * The agent + flow labels that used to live on the left were a duplicate
 * of the labeled "AGENT … FLOW …" blocks in the SessionHeader meta strip
 * directly above; we dropped them to flatten the header. Props accept
 * `agent`/`flow` for back-compat but the component no longer renders them.
 */
export function StageProgress({
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
    <div
      data-testid="stage-progress"
      className="h-7 border-b border-[var(--border)] flex items-center px-5 gap-2.5 shrink-0 bg-[rgba(0,0,0,0.12)]"
    >
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
