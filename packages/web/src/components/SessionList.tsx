import { useMemo } from "react";
import { SessionList as UISessionList, type SessionListItem } from "./ui/SessionList.js";
import { FilterChip } from "./ui/FilterChip.js";
import { Button } from "./ui/button.js";
import type { StageProgress } from "./ui/StageProgressBar.js";
import type { SessionStatus } from "./ui/StatusDot.js";
import { relTime, fmtCost } from "../util.js";
import { Plus } from "lucide-react";

interface SessionListProps {
  sessions: any[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
  filter: string;
  onFilterChange: (f: string) => void;
  search: string;
  onSearchChange: (s: string) => void;
  onNewSession: () => void;
  readOnly: boolean;
  flowStagesMap?: Record<string, any[]>;
  unreadCounts?: Record<string, number>;
}

/** Map raw session status to a valid SessionStatus type. */
function normalizeStatus(status: string): SessionStatus {
  const valid: SessionStatus[] = ["running", "waiting", "completed", "failed", "stopped", "pending"];
  if (valid.includes(status as SessionStatus)) return status as SessionStatus;
  // Map non-standard statuses
  if (status === "blocked" || status === "ready") return "pending";
  if (status === "archived" || status === "deleting") return "stopped";
  return "stopped";
}

/** Build stage progress bars from flow stages and current stage. */
function buildStageProgress(session: any, flowStagesMap?: Record<string, any[]>): StageProgress[] {
  const flowName = session.pipeline || session.flow;
  if (!flowName) return [];
  const stages = flowStagesMap?.[flowName];
  if (!stages || stages.length === 0) return [];

  const currentStage = session.stage;
  const currentIdx = stages.findIndex((s: any) => s.name === currentStage);
  const isFailed = session.status === "failed";
  const isCompleted = session.status === "completed";
  const isRunning = session.status === "running" || session.status === "waiting";

  return stages.map((s: any, i: number) => {
    if (isCompleted) return { name: s.name, state: "done" as const };
    if (isFailed && i === currentIdx) return { name: s.name, state: "failed" as const };
    if (currentIdx < 0) return { name: s.name, state: "pending" as const };
    if (i < currentIdx) return { name: s.name, state: "done" as const };
    // Only show shimmer animation for actively running sessions
    if (i === currentIdx) return { name: s.name, state: isRunning ? ("active" as const) : ("pending" as const) };
    return { name: s.name, state: "pending" as const };
  });
}

export function SessionListPanel({
  sessions,
  selectedId,
  onSelect,
  onArchive,
  onDelete,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  onNewSession,
  readOnly,
  flowStagesMap,
  unreadCounts,
}: SessionListProps) {
  // Compute status counts
  const counts = useMemo(() => {
    const c = { running: 0, waiting: 0, completed: 0, failed: 0 };
    for (const s of sessions || []) {
      if (s.status === "running") c.running++;
      else if (s.status === "waiting") c.waiting++;
      else if (s.status === "completed") c.completed++;
      else if (s.status === "failed") c.failed++;
    }
    return c;
  }, [sessions]);

  // Filter sessions
  const filtered = useMemo(() => {
    let list = sessions || [];
    if (filter !== "all") list = list.filter((s) => s.status === filter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          (s.summary || "").toLowerCase().includes(q) ||
          (s.id || "").toLowerCase().includes(q) ||
          (s.agent || "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [sessions, filter, search]);

  // Map to UI format
  const items: SessionListItem[] = useMemo(
    () =>
      filtered.map((s) => ({
        id: s.id,
        status: normalizeStatus(s.status),
        summary: s.summary || s.id,
        agentName: s.agent || "--",
        cost: s.cost != null ? fmtCost(s.cost) : "",
        relativeTime: relTime(s.updated_at),
        stages: buildStageProgress(s, flowStagesMap),
        unreadCount: unreadCounts?.[s.id] ?? 0,
      })),
    [filtered, flowStagesMap, unreadCounts],
  );

  const filterChips = (
    <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
      {(["running", "waiting", "completed", "failed"] as const)
        .filter((status) => counts[status] > 0 || filter === status)
        .map((status) => (
          <FilterChip
            key={status}
            status={status}
            count={counts[status]}
            active={filter === status}
            onClick={() => onFilterChange(filter === status ? "all" : status)}
          />
        ))}
    </div>
  );

  return (
    <UISessionList
      sessions={items}
      selectedId={selectedId}
      onSelect={onSelect}
      onArchive={!readOnly ? onArchive : undefined}
      onDelete={!readOnly ? onDelete : undefined}
      search={search}
      onSearchChange={onSearchChange}
      filterChips={filterChips}
      headerAction={
        !readOnly ? (
          <Button
            size="sm"
            variant="default"
            className="h-7 px-2.5 text-[12px] font-medium bg-[var(--primary)] text-white hover:bg-[var(--primary-hover)] gap-1"
            onClick={onNewSession}
            title="New session (n)"
          >
            <Plus size={14} />
            New Session
          </Button>
        ) : undefined
      }
    />
  );
}
