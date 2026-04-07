import { useMemo } from "react";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { relTime } from "../util.js";
import { cn } from "../lib/utils.js";

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
      <div className="flex gap-2 items-center mb-4 flex-wrap">
        <input
          className="glass-input rounded-lg px-3.5 py-[7px] pl-8 text-[13px] w-60 text-label placeholder:text-label-quaternary focus:border-tint focus:shadow-[0_0_0_3px_var(--color-tint-dim)] outline-none transition-all duration-200 bg-[length:13px] bg-[10px_center] bg-no-repeat"
          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.3)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E")` }}
          placeholder="Search sessions..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {FILTERS.map((f) => (
          <button
            key={f}
            className={cn(
              "px-4 py-1.5 rounded-full text-[13px] font-medium glass-surface border border-white/12 cursor-pointer transition-all duration-200 select-none shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
              filter === f
                ? "bg-tint-dim border-tint/30 text-tint shadow-[0_0_12px_rgba(124,106,239,0.15),inset_0_1px_0_rgba(255,255,255,0.06)]"
                : "text-white/55 hover:text-white/80 hover:bg-white/8"
            )}
            onClick={() => onFilterChange(f)}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        {groups && groups.length > 0 && (
          <select
            className="glass-input rounded-lg px-2 py-1 text-[11px] text-label outline-none focus:border-tint focus:shadow-[0_0_0_3px_var(--color-tint-dim)] transition-all duration-200 w-[120px]"
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
      {filtered.length === 0 ? (
        <div className="text-center py-24 px-6 text-label-tertiary">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            className="opacity-15 mb-4 mx-auto">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <div className="text-base font-medium text-label-secondary mb-1.5">
            No sessions yet
          </div>
          <div className="text-sm text-label-tertiary max-w-[320px] mx-auto mb-4">
            Create your first session to start orchestrating AI agents
          </div>
          <code className="inline-block px-4 py-2 rounded-lg text-sm font-mono bg-white/5 border border-white/8 text-label-secondary">ark session start --recipe quick-fix</code>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((s) => (
            <div
              key={s.id}
              className={cn(
                "glass-card glass-shine-subtle rounded-xl p-3.5 cursor-pointer transition-all duration-200 hover:bg-white/6 hover:border-white/12",
                selectedId === s.id && "!border-tint ring-1 ring-tint shadow-[0_0_0_1px_var(--color-tint),inset_0_1px_0_rgba(255,255,255,0.06),0_2px_8px_rgba(0,0,0,0.2)]"
              )}
              onClick={() => onSelect(s.id)}
            >
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <StatusDot status={s.status} />
                  <div className="min-w-0">
                    <div className="font-semibold text-label text-[13px] whitespace-nowrap overflow-hidden text-ellipsis">{s.summary || s.id}</div>
                    <div className="flex gap-3 text-label-tertiary text-[11px] mt-1">
                      <span className="whitespace-nowrap font-mono">{s.id}</span>
                      {s.agent && <span className="whitespace-nowrap font-mono">{s.agent}</span>}
                      {s.stage && <span className="whitespace-nowrap font-mono text-tint">{s.stage}</span>}
                      <span className="whitespace-nowrap font-mono">{relTime(s.updated_at)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {s.flow && s.flow !== "bare" && (
                    <span className="text-[10px] text-label-quaternary font-mono">{s.flow}</span>
                  )}
                  <StatusBadge status={s.status} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
