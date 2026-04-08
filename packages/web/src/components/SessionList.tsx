import { useMemo } from "react";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { relTime } from "../util.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Badge } from "./ui/badge.js";
import { Card } from "./ui/card.js";
import { Input } from "./ui/input.js";
import { Search, Play } from "lucide-react";

interface SessionListProps {
  sessions: any[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: string;
  onFilterChange: (f: string) => void;
  search: string;
  onSearchChange: (q: string) => void;
  groups: string[];
  groupFilter: string;
  onGroupFilter: (g: string) => void;
}

const FILTERS = ["all", "running", "waiting", "stopped", "failed", "completed"];

export function SessionList({
  sessions, selectedId, onSelect,
  filter, onFilterChange,
  search, onSearchChange,
  groups, groupFilter, onGroupFilter,
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

  return (
    <div>
      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="w-60 h-8 pl-9 pr-3 text-[13px] bg-secondary"
            placeholder="Search sessions..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        {FILTERS.map((f) => (
          <Button
            key={f}
            variant={filter === f ? "default" : "outline"}
            size="xs"
            onClick={() => onFilterChange(f)}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
          </Button>
        ))}
        {groups && groups.length > 0 && (
          <select
            className="h-7 px-2 text-[11px] bg-secondary border border-border rounded-lg text-muted-foreground outline-none focus:border-ring transition-all"
            value={groupFilter}
            onChange={(e) => onGroupFilter(e.target.value)}
          >
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        )}
      </div>

      {/* Empty state */}
      {filtered.length === 0 ? (
        <div className="flex items-center justify-center h-[calc(100vh-180px)]">
          <div className="text-center max-w-md">
            <Play size={28} className="text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground mb-4">No sessions yet</p>
            <Card className="p-3 font-mono text-xs text-muted-foreground text-left">
              <span className="text-primary">$</span> ark session start --repo . --summary "Fix login bug" --dispatch
            </Card>
          </div>
        </div>
      ) : (
        /* Session cards */
        <div className="space-y-1.5">
          {filtered.map((s) => (
            <Card
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={cn(
                "p-3 cursor-pointer transition-all duration-150",
                "hover:bg-accent hover:border-ring",
                selectedId === s.id && "bg-accent border-primary/40 ring-1 ring-primary/20"
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                  <StatusDot status={s.status} />
                  <span className="text-[13px] font-semibold text-foreground truncate">
                    {s.summary || s.id}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {s.flow && s.flow !== "bare" && (
                    <span className="text-[10px] font-mono text-muted-foreground">{s.flow}</span>
                  )}
                  <StatusBadge status={s.status} />
                </div>
              </div>
              <div className="flex gap-3 mt-1.5 text-[11px] font-mono text-muted-foreground">
                <span>{s.id}</span>
                {s.agent && <span className="text-muted-foreground">{s.agent}</span>}
                {s.stage && <span className="text-primary/60">{s.stage}</span>}
                <span>{relTime(s.updated_at)}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
