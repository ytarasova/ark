import { useMemo } from "react";
import { SessionList as UISessionList, type SessionListItem } from "./ui/SessionList.js";
import { FilterChip } from "./ui/FilterChip.js";
import type { SessionStatus } from "./ui/StatusDot.js";
import { relTime, fmtCost } from "../util.js";

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
  if (status === "blocked" || status === "ready") return "pending";
  if (status === "archived" || status === "deleting") return "stopped";
  return "stopped";
}

/** Compute progress fraction (0..1) from current stage index / total stages. */
function computeProgress(session: any, flowStagesMap?: Record<string, any[]>): number {
  if (session.status === "completed") return 1;
  if (session.status === "failed") return 1;
  const flowName = session.pipeline || session.flow;
  if (!flowName) return 0;
  const stages = flowStagesMap?.[flowName];
  if (!stages || stages.length === 0) return 0;
  const idx = stages.findIndex((s: any) => s.name === session.stage);
  if (idx < 0) return 0;
  return (idx + 1) / stages.length;
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

  const totalActive = counts.running + counts.waiting;

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
        runtime: s.runtime || s.agent_runtime || undefined,
        flow: s.pipeline || s.flow || undefined,
        stageLabel: s.stage || undefined,
        progress: computeProgress(s, flowStagesMap),
        relativeTime: relTime(s.updated_at),
        unreadCount: unreadCounts?.[s.id] ?? 0,
        agentName: s.agent,
        cost: s.cost != null ? fmtCost(s.cost) : undefined,
      })),
    [filtered, flowStagesMap, unreadCounts],
  );

  const filterChips = (
    <>
      <FilterChip
        label={`Active ${totalActive}`}
        active={filter === "active"}
        onClick={() => onFilterChange(filter === "active" ? "all" : "active")}
      />
      {counts.completed > 0 && (
        <FilterChip
          label={`Done ${counts.completed}`}
          active={filter === "completed"}
          onClick={() => onFilterChange(filter === "completed" ? "all" : "completed")}
        />
      )}
      {counts.failed > 0 && (
        <FilterChip
          label={`Failed ${counts.failed}`}
          active={filter === "failed"}
          onClick={() => onFilterChange(filter === "failed" ? "all" : "failed")}
        />
      )}
      <FilterChip label="All" active={filter === "all"} onClick={() => onFilterChange("all")} />
    </>
  );

  // Map "active" filter to combined running + waiting
  const visible = filter === "active" ? items.filter((s) => s.status === "running" || s.status === "waiting") : items;

  return (
    <UISessionList
      sessions={visible}
      selectedId={selectedId}
      onSelect={onSelect}
      onArchive={!readOnly ? onArchive : undefined}
      onDelete={!readOnly ? onDelete : undefined}
      search={search}
      onSearchChange={onSearchChange}
      filterChips={filterChips}
      onNewSession={!readOnly ? onNewSession : undefined}
      count={sessions?.length ?? 0}
    />
  );
}
