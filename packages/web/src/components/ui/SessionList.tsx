import { useState, useRef, useEffect } from "react";
import { cn } from "../../lib/utils.js";
import { StatusDot, type SessionStatus } from "./StatusDot.js";
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
  /** Progress 0..1. Kept for back-compat; rows no longer render a fill lane. */
  progress?: number;
  /** Deprecated — sparklines removed from session rows per design system. */
  sparkline?: number[];
  /** Time chip at the right of the title row (relative or absolute). */
  relativeTime: string;
  /** If > 0, renders the small primary "updated" dot next to the title. */
  unreadCount?: number;
  /** Inline error text shown on failed rows (monospace, salmon pill). */
  errorText?: string;
  /** Total tokens used on this session, pretty-formatted (e.g. "48.2k"). */
  tokens?: string;
  /** Optional compute target label (e.g. "ec2-04", "local"). */
  compute?: string;
  /** Optional agent label (e.g. "claude-sonnet-4.5"). */
  agentName?: string;
  /** Optional per-row actions. */
  cost?: string;
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
 * Session list column — rebuilt to match
 * `/tmp/ark-design-system/preview/chrome-session-list.html`.
 *
 * Each row is a tight ~52px-tall element:
 *   - 8px status pip on the left (running pip pulses).
 *   - Title (500 12.5px sans, -0.005em), optional 6px primary "updated" dot.
 *   - Right-aligned timestamp (10px mono-ui, fg-faint).
 *   - Meta row: mono-ui 10px UPPERCASE 0.04em tracking, fg-muted,
 *     format "STAGE · AGENT · COMPUTE". Right-aligned token count.
 *   - Running rows only: 2px shimmer lane under meta. No progress lane on
 *     completed / failed / waiting rows. No sparkline. No left-edge unread
 *     stripe.
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
        <h2 className="m-0 font-[family-name:var(--font-mono-ui)] text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-faint)]">
          {title}
        </h2>
        {count != null && (
          <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-medium text-[var(--fg-faint)] tabular-nums">
            · {count}
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
              "hover:bg-[var(--primary-hover)] active:bg-[#5f4ed0] transition-colors",
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
              "hover:border-[#33334d] hover:bg-[#0d0d18]",
              "transition-colors duration-150",
            )}
          />
        </div>
      )}

      {/* ── Filter chips ──────────────────────────────────────────── */}
      {filterChips && <div className="px-[12px] pt-[8px] pb-[4px] flex gap-1 shrink-0">{filterChips}</div>}

      {/* ── Session rows ──────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto py-[2px] flex flex-col">
        {sessions.map((s) => (
          <SessionRow
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
// Session Row (chrome-session-list.html `.si`)
// ---------------------------------------------------------------------------

function SessionRow({
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
  const iconBtn = cn(
    "opacity-0 group-hover:opacity-100 transition-opacity",
    "inline-flex items-center justify-center w-[18px] h-[18px] rounded bg-transparent border-0 cursor-pointer",
    "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-hover)]",
  );
  const isRunning = session.status === "running";
  const isFailed = session.status === "failed";
  const unread = (session.unreadCount ?? 0) > 0;

  const stage = session.stageLabel || session.status;
  const agent = session.agentName;
  const compute = session.compute;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(session.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(session.id);
        }
      }}
      className={cn(
        "group relative grid cursor-pointer",
        "px-[12px] py-[10px] border-b border-[var(--border-light)] last:border-b-0",
        "transition-colors duration-[120ms]",
        "hover:bg-[rgba(255,255,255,0.015)]",
        selected && "bg-[var(--bg-card)] border-[rgba(107,89,222,0.5)] shadow-[0_1px_2px_rgba(0,0,0,0.2)]",
      )}
      style={{
        gridTemplateColumns: "auto 1fr auto",
        gridTemplateRows: isRunning ? "auto auto auto" : "auto auto",
        columnGap: 10,
        rowGap: 3,
      }}
    >
      {/* Status pip -- spans rows 1/2 of the layout */}
      <span
        aria-hidden
        className="relative self-center shrink-0"
        style={{
          gridRow: "1 / 3",
          width: 8,
          height: 8,
          borderRadius: 999,
        }}
      >
        <span
          className={cn(
            "absolute inset-0 rounded-full",
            session.status === "running" && "bg-[var(--running)] shadow-[var(--running-glow)]",
            session.status === "waiting" && "bg-[var(--waiting)]",
            session.status === "completed" && "bg-[var(--completed)]",
            session.status === "failed" && "bg-[var(--failed)] shadow-[var(--failed-glow)]",
            (session.status === "stopped" || session.status === "pending") && "bg-[var(--stopped)]",
          )}
        />
        {isRunning && (
          <span
            aria-hidden
            className="absolute rounded-full border-[1.5px] border-[var(--running)] opacity-40"
            style={{
              inset: -3,
              animation: "pulse 1.6s ease-out infinite",
            }}
          />
        )}
      </span>

      {/* Title row */}
      <span
        className={cn(
          "flex items-center gap-[6px] min-w-0",
          "font-[family-name:var(--font-sans)] text-[12.5px] text-[var(--fg)] tracking-[-0.005em]",
          unread ? "font-semibold" : "font-medium",
        )}
        style={{ gridColumn: 2, gridRow: 1 }}
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap min-w-0" title={session.summary}>
          {session.summary}
        </span>
        {unread && (
          <span
            aria-hidden
            className="w-[6px] h-[6px] rounded-full bg-[var(--primary)] shrink-0"
            style={{ boxShadow: "0 0 4px rgba(107,89,222,.5)" }}
          />
        )}
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
      </span>

      {/* Meta row */}
      <span
        className="flex items-center gap-[6px] min-w-0 font-[family-name:var(--font-mono-ui)] text-[10px] font-normal uppercase tracking-[0.04em] text-[var(--fg-faint)] whitespace-nowrap overflow-hidden"
        style={{ gridColumn: 2, gridRow: 2 }}
      >
        {isFailed && session.errorText ? (
          <span
            className="px-[4px] py-0 rounded-[3px] font-[family-name:var(--font-mono)] normal-case tracking-normal text-[var(--failed)]"
            style={{ background: "rgba(248,113,113,.1)" }}
          >
            {session.errorText}
          </span>
        ) : (
          <>
            {stage && <span className="text-[var(--fg-muted)]">{stage}</span>}
            {agent && (
              <>
                <span className="opacity-50">·</span>
                <span className="truncate">{agent}</span>
              </>
            )}
            {compute && (
              <>
                <span className="opacity-50">·</span>
                <span className="truncate">{compute}</span>
              </>
            )}
          </>
        )}
      </span>

      {/* Side: time + tokens */}
      <span className="flex flex-col items-end gap-[3px] shrink-0" style={{ gridColumn: 3, gridRow: "1 / 3" }}>
        <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-normal text-[var(--fg-faint)] tabular-nums">
          {session.relativeTime}
        </span>
        {session.tokens && (
          <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-medium text-[var(--fg)] tabular-nums">
            {session.tokens}
          </span>
        )}
      </span>

      {/* Running row: 2px shimmer lane under the meta row */}
      {isRunning && (
        <span
          aria-hidden
          className="relative overflow-hidden rounded-[2px]"
          style={{
            gridColumn: "2 / 4",
            gridRow: 3,
            height: 2,
            marginTop: 5,
            background: "rgba(96,165,250,.1)",
          }}
        >
          <span
            className="absolute inset-0"
            style={{
              width: "40%",
              background: "linear-gradient(90deg, transparent, var(--running), transparent)",
              animation: "slideRight 1.6s linear infinite",
            }}
          />
        </span>
      )}
    </div>
  );
}

/** Legacy export name — kept so callers that imported `SessionCard`
 *  resolve. Points at the new row renderer. */
export { SessionRow as SessionCard };
// Re-export the dummy StatusDot symbol so older callers that imported it
// from this module still resolve.
export { StatusDot };
