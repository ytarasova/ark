import { useState, useRef, useEffect } from "react";
import { cn } from "../../lib/utils.js";
import { StatusDot, type SessionStatus } from "./StatusDot.js";
import { StageProgressBar, type StageProgress } from "./StageProgressBar.js";
import { Search, X, Archive, Trash2 } from "lucide-react";

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
  unreadCount?: number;
}

export interface SessionListProps extends React.ComponentProps<"div"> {
  sessions: SessionListItem[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  /** Per-row archive action (hover-shown icon). */
  onArchive?: (id: string) => void;
  /** Per-row delete action (hover-shown icon). */
  onDelete?: (id: string) => void;
  /** Search input value */
  search?: string;
  onSearchChange?: (value: string) => void;
  /** Header action (e.g. "+ New" button) */
  headerAction?: React.ReactNode;
  /** Filter chips rendered above the list */
  filterChips?: React.ReactNode;
}

/**
 * Left-hand sessions list panel. Classes `.list-panel`, `.list-header`,
 * `.session-card*` live in `packages/web/src/styles.css` and mirror the
 * showcase at `/tmp/ark-design-v2/packages/web/design-midnight-circuit.html`.
 */
export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onArchive,
  onDelete,
  search,
  onSearchChange,
  headerAction,
  filterChips,
  className,
  ...props
}: SessionListProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  return (
    <div className={cn("list-panel", className)} {...props}>
      <div className="list-header">
        <div className="list-header-row">
          <h2 className="list-title">Sessions</h2>
          <div className="flex items-center gap-1">
            {onSearchChange && (
              <button
                type="button"
                onClick={() => {
                  setSearchOpen(!searchOpen);
                  if (searchOpen && onSearchChange) onSearchChange("");
                }}
                className={cn(
                  "h-6 w-6 flex items-center justify-center rounded",
                  "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-hover)]",
                  "transition-colors duration-150 bg-transparent border-none p-0",
                  searchOpen && "text-[var(--fg)] bg-[var(--bg-hover)]",
                )}
                title="Search (/ )"
              >
                {searchOpen ? <X size={13} /> : <Search size={13} />}
              </button>
            )}
            {headerAction}
          </div>
        </div>

        {onSearchChange && searchOpen && (
          <div className="mb-2">
            <input
              ref={searchRef}
              type="text"
              placeholder="Search sessions..."
              value={search ?? ""}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  onSearchChange("");
                }
              }}
              aria-label="Search sessions"
              className={cn(
                "w-full h-[28px] rounded-[var(--radius-sm)] border border-[var(--border)]",
                "bg-[var(--bg-input)] px-2.5 text-[12px] text-[var(--fg)] outline-none",
                "placeholder:text-[var(--fg-faint)] focus:border-[var(--primary)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]",
                "transition-colors duration-150",
              )}
            />
          </div>
        )}

        {filterChips && <div className="mb-2.5">{filterChips}</div>}
      </div>

      <div className="list-sessions">
        {sessions.map((s) => (
          <SessionCard
            key={s.id}
            session={s}
            selected={selectedId === s.id}
            onSelect={onSelect}
            onArchive={onArchive}
            onDelete={onDelete}
          />
        ))}
        {sessions.length === 0 && (
          <div className="px-3 py-8 text-center text-[12px] text-[var(--fg-muted)]">No sessions yet</div>
        )}
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
  onArchive,
  onDelete,
}: {
  session: SessionListItem;
  selected: boolean;
  onSelect: (id: string) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const iconBtnClass = cn(
    "h-5 w-5 inline-flex items-center justify-center rounded shrink-0 bg-transparent border-none",
    "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-hover)]",
    "opacity-0 group-hover:opacity-100 transition-opacity",
  );
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(session.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(session.id);
        }
      }}
      className={cn("session-card group", selected && "active")}
    >
      <div className="session-card-top">
        <StatusDot status={session.status} size="md" />
        <span className="session-card-id">{session.id}</span>
        {session.unreadCount != null && session.unreadCount > 0 && (
          <span
            className={cn(
              "min-w-[18px] h-[18px] rounded-full ml-0.5",
              "bg-[var(--failed)] text-[var(--primary-fg)] font-[family-name:var(--font-mono-ui)] text-[10px] font-semibold leading-none tabular-nums",
              "flex items-center justify-center px-1 shrink-0",
            )}
            aria-label={`${session.unreadCount} unread`}
          >
            {session.unreadCount > 99 ? "99+" : session.unreadCount}
          </span>
        )}
        <span className="session-card-time">{session.relativeTime}</span>
        {onArchive && (
          <button
            type="button"
            title="Archive"
            aria-label={`Archive ${session.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onArchive(session.id);
            }}
            className={iconBtnClass}
          >
            <Archive size={12} />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            title="Delete"
            aria-label={`Delete ${session.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(session.id);
            }}
            className={cn(iconBtnClass, "hover:text-[var(--failed)]")}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      <div className="session-card-summary">{session.summary}</div>

      <div className="session-card-bottom">
        <StageProgressBar stages={session.stages} />
        <span className="session-card-agent">{session.agentName}</span>
        {session.cost && <span className="session-card-cost">{session.cost}</span>}
      </div>
    </div>
  );
}
