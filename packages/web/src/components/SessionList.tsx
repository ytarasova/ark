import { useMemo } from "react";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { relTime } from "../util.js";
import { cn } from "../lib/utils.js";
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
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
          <input
            className="w-60 h-8 pl-9 pr-3 text-[13px] bg-white/[0.03] border border-white/[0.06] rounded-lg text-white/90 placeholder:text-white/25 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 outline-none transition-all"
            placeholder="Search sessions..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => onFilterChange(f)}
            className={cn(
              "h-7 px-3 text-xs font-medium rounded-md border transition-colors",
              filter === f
                ? "bg-indigo-500/15 border-indigo-500/30 text-indigo-300"
                : "bg-transparent border-white/[0.06] text-white/40 hover:text-white/60 hover:border-white/[0.1]"
            )}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        {groups && groups.length > 0 && (
          <select
            className="h-7 px-2 text-[11px] bg-white/[0.03] border border-white/[0.06] rounded-lg text-white/60 outline-none focus:border-indigo-500/50 transition-all"
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
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 flex items-center justify-center mx-auto mb-4">
              <Play size={24} className="text-indigo-400" />
            </div>
            <h2 className="text-xl font-semibold text-white/90 mb-2">Create your first session</h2>
            <p className="text-sm text-white/40 mb-6 leading-relaxed">
              Sessions orchestrate AI agents to build, fix, and review code.
              Each session runs through a flow of stages with verification.
            </p>
            <div className="bg-white/[0.03] rounded-lg p-3 mb-6 font-mono text-xs text-white/50 text-left border border-white/[0.06]">
              <span className="text-indigo-400">$</span> ark session start --repo . --summary "Fix login bug" --dispatch
            </div>
            <button className="px-4 py-2 bg-indigo-500 text-white text-sm font-medium rounded-lg hover:bg-indigo-400 transition-colors">
              + New Session
            </button>
          </div>
        </div>
      ) : (
        /* Session cards */
        <div className="space-y-1.5">
          {filtered.map((s) => (
            <div
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={cn(
                "p-3 rounded-lg border cursor-pointer transition-all duration-150",
                "bg-white/[0.02] border-white/[0.04] hover:bg-white/[0.04] hover:border-white/[0.08]",
                selectedId === s.id && "bg-white/[0.05] border-indigo-500/40 ring-1 ring-indigo-500/20"
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                  <StatusDot status={s.status} />
                  <span className="text-[13px] font-semibold text-white/85 truncate">
                    {s.summary || s.id}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {s.flow && s.flow !== "bare" && (
                    <span className="text-[10px] font-mono text-white/25">{s.flow}</span>
                  )}
                  <StatusBadge status={s.status} />
                </div>
              </div>
              <div className="flex gap-3 mt-1.5 text-[11px] font-mono text-white/25">
                <span>{s.id}</span>
                {s.agent && <span className="text-white/35">{s.agent}</span>}
                {s.stage && <span className="text-indigo-400/60">{s.stage}</span>}
                <span>{relTime(s.updated_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
