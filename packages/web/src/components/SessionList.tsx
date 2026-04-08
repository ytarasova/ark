import { useMemo } from "react";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { relTime } from "../util.js";
import { cn } from "../lib/utils.js";

interface SessionListProps {
  sessions: any[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: string;
  search: string;
  groupFilter: string;
}

export function SessionList({
  sessions, selectedId, onSelect,
  filter, search, groupFilter,
}: SessionListProps) {
  const filtered = useMemo(() => {
    let list = sessions || [];
    if (filter !== "all") list = list.filter((s) => s.status === filter);
    if (groupFilter) list = list.filter((s) => s.group_name === groupFilter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((s) =>
        (s.summary || "").toLowerCase().includes(q) ||
        (s.id || "").toLowerCase().includes(q) ||
        (s.repo || "").toLowerCase().includes(q) ||
        (s.agent || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [sessions, filter, search, groupFilter]);

  if (filtered.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No sessions found
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {filtered.map((s) => (
        <div
          key={s.id}
          onClick={() => onSelect(s.id)}
          className={cn(
            "px-3 py-2.5 cursor-pointer border-b border-border transition-colors",
            "hover:bg-accent",
            selectedId === s.id && "bg-accent border-l-2 border-l-primary"
          )}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <StatusDot status={s.status} />
              <span className="text-[13px] text-foreground truncate">{s.summary || s.id}</span>
            </div>
            <StatusBadge status={s.status} />
          </div>
          <div className="flex gap-2 mt-1 text-[10px] font-mono text-muted-foreground">
            <span>{s.id}</span>
            <span>{relTime(s.updated_at)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
