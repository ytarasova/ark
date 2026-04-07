import { useMemo } from "react";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { relTime } from "../util.js";

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
      <div className="filter-bar">
        <input
          className="search-input"
          placeholder="Search sessions..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`filter-chip${filter === f ? " active" : ""}`}
            onClick={() => onFilterChange(f)}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        {groups && groups.length > 0 && (
          <select
            className="form-input"
            style={{ width: 120, padding: "4px 8px", fontSize: 11 }}
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
        <div className="empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ opacity: 0.15, marginBottom: 16 }}>
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--label-secondary)", marginBottom: 6 }}>
            No sessions yet
          </div>
          <div style={{ fontSize: 12, color: "var(--label-tertiary)", maxWidth: 280, margin: "0 auto" }}>
            Create your first session to start orchestrating AI agents
          </div>
        </div>
      ) : (
        <div className="session-list">
          {filtered.map((s) => (
            <div
              key={s.id}
              className={`session-card${selectedId === s.id ? " selected" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <div className="session-row">
                <div className="session-left">
                  <StatusDot status={s.status} />
                  <div style={{ minWidth: 0 }}>
                    <div className="session-name">{s.summary || s.id}</div>
                    <div className="session-meta">
                      <span>{s.id}</span>
                      {s.agent && <span>{s.agent}</span>}
                      {s.stage && <span style={{ color: "var(--tint)" }}>{s.stage}</span>}
                      <span>{relTime(s.updated_at)}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {s.flow && s.flow !== "bare" && (
                    <span style={{ fontSize: 10, color: "var(--label-quaternary)", fontFamily: "var(--mono)" }}>{s.flow}</span>
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
