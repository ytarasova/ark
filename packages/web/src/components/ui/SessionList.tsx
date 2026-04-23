import { useState, useRef, useEffect } from "react";
import { cn } from "../../lib/utils.js";
import { StatusDot, type SessionStatus } from "./StatusDot.js";
import { SessionLane } from "./StageProgressBar.js";
import { RuntimeChip } from "./badge.js";
import { Search, X, Plus, Archive, Trash2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionListItem {
  id: string;
  status: SessionStatus;
  /** Title / summary line. */
  summary: string;
  /** Runtime chip label, e.g. "claude", "codex". */
  runtime?: string;
  /** Flow / sub-label shown on the meta row, e.g. "autonomous-sdlc". */
  flow?: string;
  /** Additional inline stage/label text, e.g. "verifier gate". */
  stageLabel?: string;
  /** Progress 0..1. If omitted the lane defaults to 0 (pending) or 1 (done). */
  progress?: number;
  /** 24h activity bars (0..1 each). Max 12. */
  sparkline?: number[];
  /** Time chip at the right of the title row (relative or absolute). */
  relativeTime: string;
  /** If > 0, renders the unread gradient marker on the left edge. */
  unreadCount?: number;
  /** Optional per-row actions. */
  cost?: string;
  agentName?: string;
}

export interface SessionListProps extends React.ComponentProps<"div"> {
  sessions: SessionListItem[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
  search?: string;
  onSearchChange?: (value: string) => void;
  /** Filter chips rendered above the list. */
  filterChips?: React.ReactNode;
  /** Hides the "New" button when the parent is read-only. */
  onNewSession?: () => void;
  /** Heading text. Defaults to "Sessions". */
  title?: string;
  /** Count label (e.g. total sessions). */
  count?: number | string;
}

/**
 * Session list column — rebuilt from `/tmp/ark-design-system/preview/app-chrome.html`
 * (middle section) and `chrome-session-list.html`.
 *
 * Column width is enforced by the parent grid (`Layout`, 268px). The panel
 * owns:
 *   - 44px header row with title, count pill, spacer, "+ New" button.
 *   - Filter chip strip (mono-ui 10px caps, rounded-full).
 *   - Optional expandable search row.
 *   - Session cards: dense 3-row composition (title+time / meta / lane).
 */
export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onArchive,
  onDelete,
  search,
  onSearchChange,
  filterChips,
  onNewSession,
  title = "Sessions",
  count,
  className,
  ...props
}: SessionListProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  return (
    <div className={cn("flex flex-col h-full min-w-0", className)} {...props}>
      {/* ── Header row (44px) ───────────────────────────────────────── */}
      <div className="h-[44px] shrink-0 px-[14px] flex items-center gap-2 border-b border-[var(--border)]">
        <h2 className="m-0 font-[family-name:var(--font-sans)] text-[13px] font-semibold text-[var(--fg)] tracking-[-0.01em]">
          {title}
        </h2>
        {count != null && (
          <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-medium text-[var(--fg-muted)] uppercase tracking-[0.04em] tabular-nums">
            {count}
          </span>
        )}
        <span className="flex-1" />
        {onSearchChange && (
          <button
            type="button"
            onClick={() => {
              const next = !searchOpen;
              setSearchOpen(next);
              if (!next && onSearchChange) onSearchChange("");
            }}
            className={cn(
              "inline-flex items-center justify-center w-[22px] h-[22px] rounded-[5px]",
              "bg-transparent border-0 cursor-pointer transition-colors duration-150",
              "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-hover)]",
              searchOpen && "text-[var(--fg)] bg-[var(--bg-hover)]",
            )}
            title="Search"
          >
            {searchOpen ? <X size={13} /> : <Search size={13} />}
          </button>
        )}
        {onNewSession && (
          <button
            type="button"
            onClick={onNewSession}
            title="New session (n)"
            className={cn(
              "inline-flex items-center gap-1 h-[24px] px-[9px] rounded-[5px] cursor-pointer",
              "bg-[var(--primary)] text-white",
              "border border-[rgba(0,0,0,0.25)] shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
              "font-[family-name:var(--font-sans)] text-[11px] font-semibold",
              "hover:bg-[#7d6be8] active:bg-[#5f4ed0] transition-colors",
            )}
          >
            <Plus size={12} strokeWidth={2} />
            New
          </button>
        )}
      </div>

      {/* ── Search input (collapsible) ─────────────────────────────── */}
      {onSearchChange && searchOpen && (
        <div className="px-[12px] pt-[8px] pb-[2px] shrink-0">
          <input
            ref={searchRef}
            type="text"
            placeholder="Search sessions…"
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
              "w-full h-[28px] rounded-[6px] px-[10px]",
              "bg-[#0a0a12] border border-[var(--border)]",
              "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]",
              "font-[family-name:var(--font-sans)] text-[12px] text-[var(--fg)] outline-none",
              "placeholder:text-[var(--fg-faint)] focus:border-[var(--primary)]",
              "transition-colors duration-150",
            )}
          />
        </div>
      )}

      {/* ── Filter chips ──────────────────────────────────────────── */}
      {filterChips && <div className="px-[12px] pt-[8px] pb-[4px] flex gap-1 shrink-0">{filterChips}</div>}

      {/* ── Session cards ─────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-[8px] py-[4px] flex flex-col gap-[2px]">
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
          <div className="px-3 py-10 text-center text-[12px] text-[var(--fg-muted)]">No sessions yet</div>
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
  const dotBg =
    session.status === "running"
      ? "var(--running)"
      : session.status === "waiting"
        ? "var(--waiting)"
        : session.status === "completed"
          ? "var(--completed)"
          : session.status === "failed"
            ? "var(--failed)"
            : "var(--stopped)";
  const dotGlow =
    session.status === "running"
      ? "0 0 5px rgba(96,165,250,.6)"
      : session.status === "failed"
        ? "0 0 5px rgba(248,113,113,.6)"
        : undefined;
  const unreadColor =
    session.status === "waiting"
      ? { bg: "#fbbf24", glow: "rgba(251,191,36,.6)" }
      : { bg: "var(--primary)", glow: "rgba(107,89,222,.5)" };
  const progress =
    session.progress != null
      ? session.progress
      : session.status === "completed"
        ? 1
        : session.status === "running"
          ? 0.65
          : 0;
  const iconBtn = cn(
    "opacity-0 group-hover:opacity-100 transition-opacity",
    "inline-flex items-center justify-center w-[18px] h-[18px] rounded bg-transparent border-0 cursor-pointer",
    "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-hover)]",
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
        "group relative flex flex-col gap-[5px] cursor-pointer",
        "px-[10px] py-[9px] rounded-[7px]",
        "border border-transparent",
        "transition-[background,border-color] duration-150",
        "hover:bg-[rgba(255,255,255,0.015)]",
        selected && [
          "bg-[var(--bg-card)]",
          "border-[rgba(107,89,222,0.5)]",
          "shadow-[0_1px_2px_rgba(0,0,0,0.2)]",
        ],
      )}
    >
      {/* unread marker (left edge) */}
      {session.unreadCount != null && session.unreadCount > 0 && (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[3px] rounded-[3px]"
          style={{
            background: `linear-gradient(180deg, transparent, ${unreadColor.bg} 25%, ${unreadColor.bg} 75%, transparent)`,
            boxShadow: `0 0 8px ${unreadColor.glow}`,
          }}
        />
      )}

      {/* Title row */}
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="font-[family-name:var(--font-sans)] text-[12.5px] font-medium text-[var(--fg)] tracking-[-0.005em] flex-1 overflow-hidden text-ellipsis whitespace-nowrap min-w-0"
          title={session.summary}
        >
          {session.summary}
        </span>
        <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-normal text-[var(--fg-faint)] shrink-0 tabular-nums">
          {session.relativeTime}
        </span>
        {onArchive && (
          <button
            type="button"
            title="Archive"
            aria-label={`Archive ${session.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onArchive(session.id);
            }}
            className={iconBtn}
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
            className={cn(iconBtn, "hover:text-[var(--failed)]")}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-2 font-[family-name:var(--font-mono-ui)] text-[10px] font-normal text-[var(--fg-muted)]">
        <span className="inline-flex items-center gap-[3px]">
          <span
            aria-hidden
            className="w-[5px] h-[5px] rounded-full shrink-0"
            style={{ background: dotBg, boxShadow: dotGlow }}
          />
          {session.status}
          {session.stageLabel && <span className="ml-1">· {session.stageLabel}</span>}
        </span>
        {session.flow && <span className="truncate">{session.flow}</span>}
        {session.runtime && <RuntimeChip className="!h-[16px] !px-[6px] !text-[9px]">{session.runtime}</RuntimeChip>}
      </div>

      {/* Sparkline */}
      {session.sparkline && session.sparkline.length > 0 && (
        <div
          className={cn(
            "flex items-end gap-[1px] h-[10px]",
            selected ? "opacity-100" : "opacity-45",
          )}
          aria-hidden
        >
          {session.sparkline.slice(0, 12).map((h, i) => (
            <span
              key={i}
              className={cn(
                "w-[2px] rounded-[1px]",
                selected ? "bg-[var(--primary)]" : "bg-[var(--fg-muted)]",
              )}
              style={{ height: `${Math.max(0, Math.min(1, h)) * 100}%` }}
            />
          ))}
        </div>
      )}

      {/* Progress lane */}
      <SessionLane percent={progress} status={session.status} />
    </div>
  );
}

/** Legacy signature adapter so existing call sites that pass only `{id, status, summary, agentName, cost, relativeTime, stages, unreadCount}`
 *  don't break -- we accept & adapt in `SessionListPanel` instead. */
export { SessionCard };
// Re-export the dummy StatusDot symbol so older callers that imported it
// from this module still resolve.
export { StatusDot };
