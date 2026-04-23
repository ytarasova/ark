import { cn } from "../../lib/utils.js";
import { StatusBadge, type StatusBadgeStatus } from "../ui/badge.js";
import { SessionLane } from "../ui/StageProgressBar.js";

export interface ForEachIteration {
  index: number;
  /** Child session id (if one was spawned). */
  sessionId?: string;
  /** Iteration label (e.g. an input key). */
  label?: string;
  status: StatusBadgeStatus;
  startedAt?: string;
  elapsed?: string;
  tokens?: string;
  cost?: string;
}

export interface ForEachRollupProps {
  total: number;
  completed: number;
  failed?: number;
  inflight?: number;
  iterations?: ForEachIteration[];
  /** Called when an iteration row is clicked (to open the child session). */
  onOpenIteration?: (sessionId: string) => void;
  className?: string;
}

/**
 * `for_each` rollup (Phase 2).
 *
 * Rendered as a right-rail panel: a progress header (completed / total + a
 * SessionLane) followed by a compact dense table of iterations with status
 * pills, timings, and spend. An in-flight iteration is indicated by a
 * running dot on the status pill.
 */
export function ForEachRollup({
  total,
  completed,
  failed = 0,
  inflight = 0,
  iterations,
  onOpenIteration,
  className,
}: ForEachRollupProps) {
  const pct = total > 0 ? completed / total : 0;
  return (
    <div
      className={cn(
        "flex flex-col gap-[8px] p-[10px_11px] rounded-[8px]",
        "bg-[var(--bg-card)] border border-[var(--border)] shadow-[0_1px_2px_rgba(0,0,0,0.2)]",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <h3 className="m-0 font-[family-name:var(--font-mono-ui)] text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--fg-muted)]">
          For each
        </h3>
        <span className="font-[family-name:var(--font-mono-ui)] text-[10px] text-[var(--fg-faint)]">
          {completed}/{total}
          {failed > 0 && <span className="text-[var(--failed)]"> · {failed} failed</span>}
          {inflight > 0 && <span className="text-[var(--running)]"> · {inflight} in flight</span>}
        </span>
      </div>
      <SessionLane
        percent={pct}
        status={
          inflight > 0
            ? "running"
            : failed > 0 && completed < total
              ? "failed"
              : completed === total
                ? "completed"
                : "waiting"
        }
      />

      {iterations && iterations.length > 0 && (
        <div className="flex flex-col gap-[2px] max-h-[240px] overflow-y-auto -mx-[4px]">
          {iterations.map((it) => (
            <button
              key={it.index}
              type="button"
              onClick={() => it.sessionId && onOpenIteration?.(it.sessionId)}
              disabled={!it.sessionId}
              className={cn(
                "group w-full grid grid-cols-[24px_1fr_auto] items-center gap-[8px]",
                "px-[4px] py-[4px] rounded-[4px]",
                "font-[family-name:var(--font-mono-ui)] text-[10px] text-[var(--fg-muted)]",
                "bg-transparent border-0 text-left cursor-pointer",
                "hover:bg-[rgba(255,255,255,0.02)] hover:text-[var(--fg)]",
                "disabled:cursor-default disabled:hover:bg-transparent",
              )}
            >
              <span className="tabular-nums text-[var(--fg-faint)]">{String(it.index).padStart(2, "0")}</span>
              <span className="min-w-0 truncate">{it.label ?? it.sessionId ?? `iteration ${it.index}`}</span>
              <span className="flex items-center gap-[6px] shrink-0">
                {it.elapsed && <span className="tabular-nums">{it.elapsed}</span>}
                {it.cost && <span className="tabular-nums">{it.cost}</span>}
                <StatusBadge status={it.status} className="!h-[16px] !px-[6px] !text-[9px]">
                  {it.status}
                </StatusBadge>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Child session cluster (parent_id linkage)
// ──────────────────────────────────────────────────────────────────────────

export interface ChildSessionClusterItem {
  id: string;
  summary: string;
  status: StatusBadgeStatus;
  branch?: string;
}

export interface ChildSessionClusterProps {
  parentId?: string;
  children: ChildSessionClusterItem[];
  onOpen?: (id: string) => void;
  className?: string;
}

/**
 * Child session cluster view (Phase 2) -- grouped view of sessions that share
 * a parent_id. Rendered inline in the detail body when a session has
 * children OR is itself a child.
 */
export function ChildSessionCluster({ parentId, children, onOpen, className }: ChildSessionClusterProps) {
  if (!children || children.length === 0) return null;
  return (
    <div
      className={cn(
        "flex flex-col gap-[6px] p-[10px_11px] rounded-[8px]",
        "bg-[var(--bg-card)] border border-[var(--border)] shadow-[0_1px_2px_rgba(0,0,0,0.2)]",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <h3 className="m-0 font-[family-name:var(--font-mono-ui)] text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--fg-muted)]">
          Child sessions
        </h3>
        {parentId && (
          <span className="font-[family-name:var(--font-mono-ui)] text-[10px] text-[var(--fg-faint)]">
            parent <span className="text-[var(--fg)]">{parentId}</span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-[2px]">
        {children.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onOpen?.(c.id)}
            className={cn(
              "group flex items-center gap-[8px] px-[6px] py-[4px] rounded-[4px] w-full",
              "bg-transparent border-0 text-left cursor-pointer",
              "hover:bg-[rgba(255,255,255,0.02)]",
            )}
          >
            <StatusBadge status={c.status} className="!h-[16px] !px-[6px] !text-[9px] shrink-0">
              {c.status}
            </StatusBadge>
            <span className="font-[family-name:var(--font-sans)] text-[11px] text-[var(--fg)] truncate flex-1 min-w-0">
              {c.summary}
            </span>
            {c.branch && (
              <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--fg-muted)] shrink-0">
                {c.branch}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
