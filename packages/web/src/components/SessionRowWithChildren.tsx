import { ChevronRight, ChevronDown, Zap, Check, X, CornerUpLeft } from "lucide-react";
import { useSessionChildrenQuery } from "../hooks/useSessionQueries.js";
import { SessionRow } from "./ui/SessionList.js";
import { sessionToListItem } from "./SessionList.js";
import { cn } from "../lib/utils.js";
import { fmtCost } from "../util.js";

export interface SessionRowWithChildrenProps {
  session: any;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  flowStagesMap?: Record<string, any[]>;
  unreadCounts?: Record<string, number>;
}

/**
 * Tree-aware wrapper around the shared SessionRow atom.
 *
 * Renders a single row with:
 *  - A disclosure chevron (leading slot) when the session has `child_stats`
 *    with `total > 0`.
 *  - A rollup chip (trailing slot) summarising running/done/failed + cost.
 *  - A parent breadcrumb chip when rendered as a child in flat / search
 *    contexts (i.e. whenever `parent_id` is non-null).
 *
 * On expand, lazily fetches `session/list_children` and recursively renders
 * each child below this row with `pl-6` (20px) per depth level. Past depth 3
 * the row surfaces a "Show full tree" link that jumps to the root session
 * detail page so the list doesn't become unreadable in deep fan-outs.
 */
export function SessionRowWithChildren({
  session,
  depth,
  selectedId,
  onSelect,
  onArchive,
  onDelete,
  expanded,
  onToggleExpand,
  flowStagesMap,
  unreadCounts,
}: SessionRowWithChildrenProps) {
  const stats = session.child_stats ?? null;
  const hasChildren = !!stats && stats.total > 0;
  const isOpen = hasChildren && expanded.has(session.id);
  const tooDeep = depth >= 3;

  const childQuery = useSessionChildrenQuery(session.id, isOpen && !tooDeep);
  const children: any[] = childQuery.data ?? [];

  // When the row is expanded we have fresher child status than the parent
  // row's attached `child_iterations` (which is at-most-as-fresh as the
  // parent list response). Pass them through so the segmented strip
  // reflects in-flight transitions live; collapsed rows fall back to the
  // server-attached snapshot in `session.child_iterations`.
  const item = sessionToListItem(session, flowStagesMap, unreadCounts, isOpen ? children : null);

  const chevron = hasChildren ? (
    <button
      type="button"
      data-testid="tree-chevron"
      aria-label={isOpen ? "Collapse children" : "Expand children"}
      aria-expanded={isOpen}
      onClick={(e) => {
        e.stopPropagation();
        onToggleExpand(session.id);
      }}
      className={cn(
        "inline-flex items-center justify-center w-[16px] h-[16px] shrink-0",
        "rounded text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-hover)]",
        "transition-colors cursor-pointer",
      )}
    >
      {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
    </button>
  ) : (
    <span aria-hidden className="inline-block w-[16px] h-[16px] shrink-0" />
  );

  const rollup = hasChildren && stats ? <ChildStatsChip stats={stats} /> : null;

  // Breadcrumb chip for child rows rendered outside their parent context
  // (e.g. search results). We always show it when this row has a parent.
  const parentChip =
    session.parent_id != null && depth === 0 ? (
      <a
        href={`#/sessions/${session.parent_id}`}
        data-testid="parent-breadcrumb-chip"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "inline-flex items-center gap-[3px] px-[5px] py-[1px] rounded-[3px] shrink-0",
          "font-[family-name:var(--font-mono-ui)] text-[10px] uppercase tracking-[0.04em]",
          "bg-[rgba(107,89,222,0.12)] text-[var(--fg-muted)] hover:text-[var(--fg)] no-underline",
        )}
        title={`Part of ${session.parent_summary || session.parent_id}`}
      >
        <CornerUpLeft size={10} strokeWidth={2} />
        <span className="normal-case tracking-normal">part of</span>
        <span className="truncate max-w-[160px] normal-case tracking-normal">
          {truncate(session.parent_summary || session.parent_id, 40)}
        </span>
      </a>
    ) : null;

  return (
    <div data-testid="session-tree-row" data-depth={depth} data-session-id={session.id}>
      <SessionRow
        session={item}
        selected={selectedId === session.id}
        onSelect={onSelect}
        onArchive={onArchive}
        onDelete={onDelete}
        leading={chevron}
        trailing={
          <span className="inline-flex items-center gap-[6px]">
            {parentChip}
            {rollup}
          </span>
        }
        indent={depth * 24}
      />

      {isOpen && !tooDeep && (
        <div data-testid="tree-children" role="group">
          {childQuery.isLoading && children.length === 0 && (
            <div
              className="px-[12px] py-[6px] text-[10px] text-[var(--fg-faint)]
                font-[family-name:var(--font-mono-ui)] uppercase tracking-[0.05em]"
              style={{ marginLeft: 8 + (depth + 1) * 24 }}
            >
              Loading children…
            </div>
          )}
          {children.map((c) => (
            <SessionRowWithChildren
              key={c.id}
              session={c}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onArchive={onArchive}
              onDelete={onDelete}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              flowStagesMap={flowStagesMap}
              unreadCounts={unreadCounts}
            />
          ))}
        </div>
      )}

      {isOpen && tooDeep && (
        <a
          href={`#/sessions/${rootIdFor(session)}`}
          data-testid="show-full-tree-link"
          onClick={(e) => e.stopPropagation()}
          className="block px-[12px] py-[4px] text-[11px] text-[var(--primary)] hover:underline no-underline"
          style={{ marginLeft: 8 + depth * 24 }}
        >
          Show full tree →
        </a>
      )}
    </div>
  );
}

function ChildStatsChip({
  stats,
}: {
  stats: { running: number; completed: number; failed: number; cost_usd_sum: number };
}) {
  return (
    <span
      data-testid="child-stats-chip"
      className={cn(
        "inline-flex items-center gap-[6px] px-[6px] py-[1px] rounded-[3px]",
        "font-[family-name:var(--font-mono-ui)] text-[10px] uppercase tracking-[0.04em]",
        "bg-[rgba(255,255,255,0.03)] text-[var(--fg-muted)]",
      )}
    >
      <span className="inline-flex items-center gap-[2px] text-[#7dbbff]">
        <Zap size={10} strokeWidth={2} />
        <span className="tabular-nums">{stats.running}</span>
      </span>
      <span aria-hidden className="opacity-30">
        ·
      </span>
      <span className="inline-flex items-center gap-[2px] text-[#6ee7b7]">
        <Check size={10} strokeWidth={2.25} />
        <span className="tabular-nums">{stats.completed}</span>
      </span>
      <span aria-hidden className="opacity-30">
        ·
      </span>
      <span className="inline-flex items-center gap-[2px] text-[var(--failed)]">
        <X size={10} strokeWidth={2.25} />
        <span className="tabular-nums">{stats.failed}</span>
      </span>
      {stats.cost_usd_sum > 0 && (
        <>
          <span aria-hidden className="opacity-30">
            ·
          </span>
          <span className="text-[var(--fg-muted)] tabular-nums normal-case">{fmtCost(stats.cost_usd_sum)}</span>
        </>
      )}
    </span>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Walk up to the root id for this row. In list context we usually only have
 * the direct `parent_id`; past depth 3 we don't have the tree here, so we
 * fall back to the session's own id (the Flow tab on the detail page will
 * load the actual tree and reconcile).
 */
function rootIdFor(session: any): string {
  return session.root_id || session.parent_id || session.id;
}
