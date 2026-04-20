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
    <div className={cn("flex flex-col overflow-hidden", className)} {...props}>
      {/* Header */}
      <div className="px-4 pt-4 pb-1 shrink-0">
        <div className="flex items-center justify-between mb-2.5">
          <h2 className="text-[18px] font-semibold text-[var(--fg)]">Sessions</h2>
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
                  "transition-colors duration-150",
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

        {/* Search -- expandable */}
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
                "bg-[var(--bg-input,transparent)] px-2.5 text-[12px] text-[var(--fg)] outline-none",
                "placeholder:text-[var(--fg-faint)] focus:border-[var(--primary)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]",
                "transition-colors duration-150",
              )}
            />
          </div>
        )}

        {/* Filter chips -- horizontal scroll, no wrap */}
        {filterChips && <div className="mb-2.5">{filterChips}</div>}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
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
    "h-5 w-5 inline-flex items-center justify-center rounded shrink-0",
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
      className={cn(
        "group flex flex-col gap-1 w-full text-left px-2 py-3 rounded-[var(--radius-sm)]",
        "cursor-pointer border-l-[3px] border-transparent min-h-[52px] justify-center",
        "hover:bg-[var(--bg-hover)] transition-colors duration-150",
        selected && "bg-[var(--primary-subtle)] border-l-[var(--primary)]",
      )}
    >
      {/* Top row: dot + id + unread badge + time + hover actions */}
      <div className="flex items-center gap-1.5">
        <StatusDot status={session.status} size="md" />
        <span className="font-[family-name:var(--font-mono-ui)] text-[12px] text-[var(--fg-muted)]">{session.id}</span>
        {session.unreadCount != null && session.unreadCount > 0 && (
          <span
            className={cn(
              "min-w-[18px] h-[18px] rounded-full",
              "bg-red-500 text-white text-[10px] font-bold leading-none",
              "flex items-center justify-center px-1 shrink-0",
            )}
            aria-label={`${session.unreadCount} unread`}
          >
            {session.unreadCount > 99 ? "99+" : session.unreadCount}
          </span>
        )}
        <span className="text-[11px] text-[var(--fg-muted)] ml-auto">{session.relativeTime}</span>
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

      {/* Summary */}
      <div className="text-[14px] font-medium truncate pl-[13px]">{session.summary}</div>

      {/* Bottom row: pipeline + agent + cost */}
      <div className="flex items-center gap-1.5 pl-[13px]">
        <StageProgressBar stages={session.stages} />
        <span className="font-[family-name:var(--font-mono-ui)] text-[11px] text-[var(--fg-muted)]">
          {session.agentName}
        </span>
        <span className="font-[family-name:var(--font-mono-ui)] text-[11px] text-[var(--fg-muted)]">
          {session.cost}
        </span>
      </div>
    </div>
  );
}
