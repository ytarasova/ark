import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../hooks/useApi.js";
import { useSessionTreeStream } from "../../hooks/useSessionTreeStream.js";
import { cn } from "../../lib/utils.js";
import { fmtCost, fmtDuration, relTime } from "../../util.js";

/**
 * Full session tree panel rendered on the Flow tab for root + parent
 * sessions. Uses `session/tree` for the initial snapshot and subscribes to
 * live updates via the JSON-RPC `session/tree-stream` WebSocket subscription
 * (200ms debounced server-side).
 *
 * Deliberately kept as a dedicated renderer rather than overloading
 * `FlowDag`, which encodes stage-level pipeline semantics (done/running/
 * pending edges, marker arrows, shimmer bars) that don't map onto a
 * session tree's parent/child shape.
 */
export interface FlowTreePanelProps {
  /** The session being viewed (may itself be a child). */
  session: { id: string; parent_id: string | null; summary: string | null };
  /** Optional pre-resolved rootId (walk up from a child if known). */
  rootId?: string | null;
}

export function FlowTreePanel({ session, rootId: rootIdProp }: FlowTreePanelProps) {
  const rootId = rootIdProp ?? session.parent_id ?? session.id;
  const api = useApi();

  const { data: root, isLoading } = useQuery({
    queryKey: ["session-tree", rootId],
    queryFn: () => api.getSessionTree(rootId).then((r) => r.root),
    staleTime: 5_000,
  });

  // Subscribe to JSON-RPC tree updates so the react-query cache stays fresh
  // while this panel is mounted. Server debounces snapshots to 200ms.
  useSessionTreeStream(rootId);

  const flat = useMemo(() => (root ? flatten(root, 0, true) : []), [root]);

  if (isLoading && !root) {
    return (
      <div
        data-testid="flow-tree-loading"
        className="px-[14px] py-[16px] text-[11px] text-[var(--fg-faint)] font-[family-name:var(--font-mono-ui)] uppercase tracking-[0.05em]"
      >
        Loading tree…
      </div>
    );
  }

  if (!root) return null;

  return (
    <div
      data-testid="flow-tree-panel"
      className={cn(
        "rounded-[10px] border border-[var(--border)] bg-[var(--bg-card)]",
        "shadow-[0_1px_2px_rgba(0,0,0,0.4)] p-[12px_14px]",
      )}
    >
      <div className="flex items-center justify-between mb-[10px]">
        <div className="font-[family-name:var(--font-sans)] text-[12px] font-semibold text-[var(--fg)]">
          Session tree
          <span className="ml-[6px] font-[family-name:var(--font-mono-ui)] text-[10px] font-normal uppercase tracking-[0.04em] text-[var(--fg-faint)]">
            {root.id} · {flat.length} {flat.length === 1 ? "session" : "sessions"}
          </span>
        </div>
      </div>

      <div
        className="relative overflow-auto rounded-[8px] border border-[rgba(0,0,0,0.5)] p-[10px]"
        style={{ backgroundColor: "#0c0c18" }}
      >
        <ul role="tree" className="flex flex-col gap-[4px] m-0 p-0 list-none">
          {flat.map((node) => (
            <TreeNodeRow
              key={node.session.id}
              depth={node.depth}
              session={node.session}
              highlight={node.session.id === session.id}
              isRoot={node.isRoot}
              hasConnector={node.depth > 0}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

interface FlatNode {
  session: any;
  depth: number;
  isRoot: boolean;
}

function flatten(root: any, depth: number, isRoot: boolean): FlatNode[] {
  const out: FlatNode[] = [{ session: root, depth, isRoot }];
  const children = Array.isArray(root?.children) ? root.children : [];
  for (const c of children) out.push(...flatten(c, depth + 1, false));
  return out;
}

function TreeNodeRow({
  session,
  depth,
  isRoot,
  highlight,
  hasConnector,
}: {
  session: any;
  depth: number;
  isRoot: boolean;
  highlight: boolean;
  hasConnector: boolean;
}) {
  const status = session.status as string;
  const dot = statusColor(status);
  const cost = session.child_stats?.cost_usd_sum ?? session.cost ?? 0;
  const duration = fmtDuration(session.started_at || session.created_at) || relTime(session.created_at);

  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      data-testid="flow-tree-node"
      data-root={isRoot ? "true" : undefined}
      data-depth={depth}
      style={{ paddingLeft: depth * 20 }}
      className="relative"
    >
      {/* SVG connector from the parent stub to this node. */}
      {hasConnector && (
        <svg aria-hidden width={20} height={28} className="absolute" style={{ left: (depth - 1) * 20 + 4, top: 0 }}>
          <line
            x1={8}
            y1={0}
            x2={8}
            y2={14}
            stroke="#3a3a54"
            strokeWidth={1}
            className={status === "running" ? "dag-edge-active" : undefined}
            strokeDasharray={status === "running" ? "6 4" : undefined}
          />
          <line x1={8} y1={14} x2={18} y2={14} stroke="#3a3a54" strokeWidth={1} />
        </svg>
      )}
      <div
        className={cn(
          "flex items-center gap-[8px] px-[10px] py-[6px] rounded-[6px]",
          "font-[family-name:var(--font-sans)] text-[12px]",
          "border transition-colors",
          isRoot
            ? "bg-[rgba(107,89,222,0.08)] border-[rgba(107,89,222,0.4)]"
            : "bg-[rgba(255,255,255,0.015)] border-[var(--border)]",
          highlight && "ring-1 ring-[var(--primary)]",
        )}
      >
        <span
          aria-hidden
          data-testid="flow-tree-node-dot"
          className={cn("inline-block w-[7px] h-[7px] rounded-full shrink-0", dot.animate && "animate-pulse")}
          style={{ backgroundColor: dot.color, boxShadow: dot.glow }}
        />
        <a
          href={`#/sessions/${session.id}`}
          className="flex-1 min-w-0 truncate text-[var(--fg)] no-underline hover:underline"
          title={session.summary || session.id}
        >
          {session.summary || session.id}
        </a>
        <span className="font-[family-name:var(--font-mono-ui)] text-[10px] tabular-nums text-[var(--fg-faint)] shrink-0">
          {duration}
        </span>
        {cost > 0 && (
          <span className="font-[family-name:var(--font-mono-ui)] text-[10px] tabular-nums text-[var(--fg-muted)] shrink-0">
            {fmtCost(cost)}
          </span>
        )}
      </div>
    </li>
  );
}

function statusColor(status: string): { color: string; glow?: string; animate: boolean } {
  switch (status) {
    case "running":
      return { color: "#60a5fa", glow: "0 0 6px rgba(96,165,250,0.6)", animate: true };
    case "completed":
      return { color: "#34d399", glow: "0 0 5px rgba(52,211,153,0.5)", animate: false };
    case "failed":
      return { color: "#f87171", glow: "0 0 5px rgba(248,113,113,0.5)", animate: false };
    case "waiting":
      return { color: "#fbbf24", animate: false };
    default:
      return { color: "#3a3a54", animate: false };
  }
}
