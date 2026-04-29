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
  /** Progress 0..1 (0=empty, 1=full). Used as a fallback when `stages` is
   *  not provided -- a single thin lane gets rendered instead of segmented
   *  per-stage chips. */
  progress?: number;
  /** Per-stage progress segments. Each entry is one stage of the session's
   *  flow. When present this replaces the single progress lane with one
   *  segment per stage (GH Actions style). Drop the sparkline entirely --
   *  the segmented strip already conveys "where are we in the flow" plus
   *  "how much is left", which is what the sparkline was approximating. */
  stages?: { name: string; state: "done" | "active" | "pending" | "failed" | "skipped" }[];
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
  /**
   * If provided, renders this node in place of the default flat `sessions`
   * body. Used by the tree-aware wrapper to inject its own row renderer
   * (with chevrons + child expansion) while keeping the shared header +
   * search + filter chrome from this atom.
   */
  children?: React.ReactNode;
}

/**
 * Session list column — rebuilt from the user-05-desired-list reference.
 *
 * Each row composes:
 *   - 3px left-edge accent stripe: amber for waiting / purple for selected /
 *     nothing for default / completed / failed. Faded top/bottom via gradient.
 *   - Title row: sans 14px 500, right-aligned elapsed time (mono-ui 11px).
 *   - Meta row: small status dot + flow-name text + runtime label.
 *   - 24h mini sparkline (~11 bars). Amber when idle, primary when active,
 *     status-colored for completed/waiting/failed. If no data we render a
 *     muted placeholder so vertical rhythm is preserved.
 *   - Thin (3px) progress lane beneath the sparkline:
 *       running   blue->purple gradient + shimmer
 *       completed solid green
 *       waiting   amber
 *       failed    red
 *   - Selected row: bg-card + purple border + subtle drop shadow.
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
  children,
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
      {filterChips && (
        <div className="px-[12px] pt-[8px] pb-[6px] flex items-center gap-[6px] shrink-0">{filterChips}</div>
      )}

      {/* ── Session rows ──────────────────────────────────────────── */}
      {children ?? (
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
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session Row (chrome-session-list.html `.si`)
// ---------------------------------------------------------------------------

// Map session status to the progress strip's fill + track colors.
function laneColors(status: SessionStatus): {
  fill: string;
  track: string;
  shimmer?: boolean;
} {
  switch (status) {
    case "running":
      return {
        fill: "linear-gradient(90deg, #60a5fa 0%, #8b5cf6 100%)",
        track: "rgba(96,165,250,0.12)",
        shimmer: true,
      };
    case "completed":
      return { fill: "var(--completed)", track: "rgba(52,211,153,0.12)" };
    case "waiting":
      return { fill: "var(--waiting)", track: "rgba(251,191,36,0.12)" };
    case "failed":
      return { fill: "var(--failed)", track: "rgba(248,113,113,0.12)" };
    default:
      return { fill: "rgba(255,255,255,0.12)", track: "rgba(255,255,255,0.05)" };
  }
}

// Per-segment color for the GH-Actions-style stage strip.
function segmentColor(state: "done" | "active" | "pending" | "failed" | "skipped"): {
  bg: string;
  shimmer?: boolean;
} {
  switch (state) {
    case "done":
      return { bg: "var(--completed)" };
    case "active":
      return { bg: "linear-gradient(90deg, #60a5fa 0%, #8b5cf6 100%)", shimmer: true };
    case "failed":
      return { bg: "var(--failed)" };
    case "skipped":
      return { bg: "rgba(255,255,255,0.06)" };
    default:
      return { bg: "rgba(255,255,255,0.10)" };
  }
}

/** GH-Actions style segmented progress strip. One segment per stage in the
 *  flow. Falls back to a single solid bar when the session has no stage
 *  list (no flow registered, dispatch hasn't loaded it yet, etc). */
function StageStrip({
  stages,
  status,
  progress,
  lane,
}: {
  stages: SessionListItem["stages"];
  status: SessionStatus;
  progress: number;
  lane: { fill: string; track: string; shimmer?: boolean };
}) {
  if (!stages || stages.length === 0) {
    // Fallback single-bar mode for sessions without a known flow shape.
    return (
      <div
        aria-hidden
        className="mt-[6px] relative overflow-hidden rounded-[2px]"
        style={{ height: 3, background: lane.track }}
      >
        <span
          className="absolute top-0 left-0 h-full"
          style={{ width: `${progress * 100}%`, background: lane.fill, borderRadius: 2 }}
        />
        {lane.shimmer && (
          <span
            className="absolute inset-y-0"
            style={{
              width: "30%",
              left: 0,
              background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)",
              animation: "slideRight 1.6s linear infinite",
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div
      aria-label={`Flow progress: ${stages.filter((s) => s.state === "done").length} of ${stages.length} stages done${
        status === "failed" ? " (failed)" : ""
      }`}
      role="progressbar"
      className="mt-[6px] flex items-stretch gap-[3px] w-full"
      style={{ height: 4 }}
    >
      {stages.map((s, i) => {
        const c = segmentColor(s.state);
        return (
          <span
            key={`${s.name}-${i}`}
            title={`${s.name} — ${s.state}`}
            className="flex-1 relative overflow-hidden rounded-[2px]"
            style={{ background: c.bg, minWidth: 4 }}
          >
            {c.shimmer && (
              <span
                aria-hidden
                className="absolute inset-y-0"
                style={{
                  width: "40%",
                  left: 0,
                  background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)",
                  animation: "slideRight 1.6s linear infinite",
                }}
              />
            )}
          </span>
        );
      })}
    </div>
  );
}

export function SessionRow({
  session,
  selected,
  onSelect,
  onArchive,
  onDelete,
  leading,
  trailing,
  indent = 0,
}: {
  session: SessionListItem;
  selected: boolean;
  onSelect: (id: string) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Optional leading content rendered before the title (e.g. disclosure chevron). */
  leading?: React.ReactNode;
  /** Optional trailing content rendered on the meta row (e.g. child rollup chip). */
  trailing?: React.ReactNode;
  /** Indentation depth in px applied to the card's left margin (tree mode). */
  indent?: number;
}) {
  const iconBtn = cn(
    "opacity-0 group-hover:opacity-100 transition-opacity",
    "inline-flex items-center justify-center w-[18px] h-[18px] rounded bg-transparent border-0 cursor-pointer",
    "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-hover)]",
  );
  const isRunning = session.status === "running";
  const isFailed = session.status === "failed";
  const isWaiting = session.status === "waiting";
  const unread = (session.unreadCount ?? 0) > 0;

  const lane = laneColors(session.status);
  const progress = Math.max(0, Math.min(1, session.progress ?? (isRunning ? 0.4 : isFailed ? 0.6 : 1)));

  const flow = session.flow;
  const runtime = session.runtime;
  const stageLabel = session.stageLabel;

  // Left-edge accent stripe: purple for selected, amber for waiting, none otherwise.
  const stripeColor = selected ? "var(--primary)" : isWaiting ? "var(--waiting)" : undefined;

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
      data-selected={selected ? "true" : undefined}
      className={cn(
        "group relative flex flex-col cursor-pointer",
        "my-[3px] rounded-[8px] px-[12px] py-[10px]",
        "border border-transparent transition-colors duration-[120ms]",
        "hover:bg-[rgba(255,255,255,0.015)]",
        // Selected: card bg + brand-accent border. Uses --primary so the
        // ring matches the `+ New` button + brand tile gradient regardless
        // of active theme (purple in midnight-circuit, amber in warm-obsidian).
        selected && "bg-[var(--bg-card)] border-[var(--primary)] shadow-[0_2px_8px_rgba(0,0,0,0.25)]",
      )}
      style={{ marginLeft: 8 + indent, marginRight: 8 }}
    >
      {/* Left-edge accent stripe (3px, faded top/bottom). */}
      {stripeColor && (
        <span
          aria-hidden
          className="absolute left-0 top-[6px] bottom-[6px] w-[3px] rounded-r-[2px]"
          style={{
            background: `linear-gradient(180deg, transparent 0%, ${stripeColor} 15%, ${stripeColor} 85%, transparent 100%)`,
            boxShadow: `0 0 6px ${stripeColor}`,
            opacity: 0.85,
          }}
        />
      )}

      {/* Title row: summary + elapsed time. */}
      <div className="flex items-center gap-[8px] min-w-0">
        {leading}
        <span
          className={cn(
            "flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap",
            "font-[family-name:var(--font-sans)] text-[14px] tracking-[-0.005em] text-[var(--fg)]",
            unread ? "font-semibold" : "font-medium",
          )}
          title={session.summary}
        >
          {session.summary}
        </span>
        {unread && (
          <span
            aria-hidden
            className="w-[6px] h-[6px] rounded-full bg-[var(--primary)] shrink-0"
            style={{ boxShadow: "0 0 4px var(--primary)" }}
          />
        )}
        <span className="font-[family-name:var(--font-mono-ui)] text-[11px] font-normal text-[var(--fg-faint)] tabular-nums shrink-0">
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

      {/* Meta row: status dot + status word + flow + star + runtime. */}
      <div className="mt-[4px] flex items-center gap-[8px] min-w-0 font-[family-name:var(--font-mono-ui)] text-[11px] text-[var(--fg-muted)] whitespace-nowrap overflow-hidden">
        <StatusDot status={session.status} size="md" pulse={isRunning} />
        <span className="text-[var(--fg-muted)]">{session.status}</span>
        {isFailed && session.errorText ? (
          <span
            className="px-[4px] py-0 rounded-[3px] font-[family-name:var(--font-mono)] normal-case tracking-normal text-[var(--failed)]"
            style={{ background: "rgba(248,113,113,.1)" }}
          >
            {session.errorText}
          </span>
        ) : (
          <>
            {flow && <span className="truncate text-[var(--fg-muted)]">{flow}</span>}
            {!flow && stageLabel && <span className="truncate text-[var(--fg-muted)]">{stageLabel}</span>}
            {runtime && (
              <span className="inline-flex items-center gap-[4px] shrink-0 text-[var(--fg-muted)]">
                <span>{runtime}</span>
              </span>
            )}
          </>
        )}
        {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
      </div>

      {/* Progress strip. When the session has a stage list (most flows do)
          we render one segment per stage -- GH-Actions style -- so the row
          shows "stage 2 of 5 done, currently on stage 3, 2 to go" at a
          glance. Otherwise we fall back to a single solid lane. The
          previous 24h activity sparkline was decorative and visually
          competed with the progress; dropped it. */}
      <StageStrip stages={session.stages} status={session.status} progress={progress} lane={lane} />
    </div>
  );
}

/** Legacy export name — kept so callers that imported `SessionCard`
 *  resolve. Points at the new row renderer. */
export { SessionRow as SessionCard };
// Re-export the dummy StatusDot symbol so older callers that imported it
// from this module still resolve.
export { StatusDot };
