import { cn } from "../../lib/utils.js";
import { StatusDot, type SessionStatus } from "./StatusDot.js";
import { StageProgressBar, type StageProgress } from "./StageProgressBar.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionListItem {
  id: string;
  status: SessionStatus;
  summary: string;
  agentName: string;
  cost: string;
  relativeTime: string;
  stages: StageProgress[];
}

export interface SessionListProps extends React.ComponentProps<"div"> {
  sessions: SessionListItem[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  /** Search input value */
  search?: string;
  onSearchChange?: (value: string) => void;
  /** Header action (e.g. "+ New" button) */
  headerAction?: React.ReactNode;
  /** Filter chips rendered above the list */
  filterChips?: React.ReactNode;
}

/**
 * Enhanced session list panel with search, filter chips, and session cards
 * with stage progress bars and cost per session.
 */
export function SessionList({
  sessions,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  headerAction,
  filterChips,
  className,
  ...props
}: SessionListProps) {
  return (
    <div className={cn("flex flex-col overflow-hidden", className)} {...props}>
      {/* Header */}
      <div className="px-4 pt-4 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[16px] font-semibold tracking-[-0.01em]">Sessions</h2>
          {headerAction}
        </div>

        {/* Search */}
        {onSearchChange && (
          <div className="mb-2.5">
            <input
              type="text"
              placeholder="Search sessions..."
              value={search ?? ""}
              onChange={(e) => onSearchChange(e.target.value)}
              className={cn(
                "w-full h-[30px] rounded-[var(--radius-sm)] border border-[var(--border)]",
                "bg-[var(--bg-input)] px-2.5 text-[12px] text-[var(--fg)] outline-none",
                "placeholder:text-[var(--fg-faint)] focus:border-[var(--primary)]",
                "transition-colors duration-150",
              )}
            />
          </div>
        )}

        {/* Filter chips */}
        {filterChips && <div className="flex gap-1.5 mb-3 flex-wrap">{filterChips}</div>}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.map((s) => (
          <SessionCard key={s.id} session={s} selected={selectedId === s.id} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session Card
// ---------------------------------------------------------------------------

function SessionCard({
  session,
  selected,
  onSelect,
}: {
  session: SessionListItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      className={cn(
        "flex flex-col gap-0.5 w-full text-left px-2 py-2 rounded-[var(--radius-sm)]",
        "cursor-pointer border-l-[3px] border-transparent min-h-[52px] justify-center",
        "hover:bg-[var(--bg-hover)] transition-colors duration-150",
        selected && "bg-[var(--primary-subtle)] border-l-[var(--primary)]",
      )}
    >
      {/* Top row: dot + id + time */}
      <div className="flex items-center gap-1.5">
        <StatusDot status={session.status} size="md" />
        <span className="font-[family-name:var(--font-mono-ui)] text-[11px] text-[var(--fg-muted)]">{session.id}</span>
        <span className="text-[10px] text-[var(--fg-muted)] ml-auto">{session.relativeTime}</span>
      </div>

      {/* Summary */}
      <div className="text-[12px] font-medium truncate pl-[13px]">{session.summary}</div>

      {/* Bottom row: pipeline + agent + cost */}
      <div className="flex items-center gap-1.5 pl-[13px]">
        <StageProgressBar stages={session.stages} />
        <span className="text-[10px] text-[var(--fg-muted)]">{session.agentName}</span>
        <span className="font-[family-name:var(--font-mono-ui)] text-[10px] text-[var(--fg-muted)]">
          {session.cost}
        </span>
      </div>
    </button>
  );
}
