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
  onNewSession: () => void;
  readOnly: boolean;
}

const FILTERS = ["all", "running", "waiting", "stopped", "failed", "completed"];

export function SessionList({
  sessions, selectedId, onSelect,
  filter, onFilterChange,
  search, onSearchChange,
  groups, groupFilter, onGroupFilter,
  onNewSession, readOnly,
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
            style={{ width: 140, padding: "5px 8px" }}
            value={groupFilter}
            onChange={(e) => onGroupFilter(e.target.value)}
          >
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        )}
        {!readOnly && (
          <button className="btn btn-primary" onClick={onNewSession}>+ New Session</button>
        )}
      </div>
      {filtered.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">{"\u2205"}</div>
          <div className="empty-text">No sessions match your filters</div>
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
                  <span className="session-name">{s.summary || s.id}</span>
                </div>
                <StatusBadge status={s.status} />
              </div>
              <div className="session-meta">
                <span>{s.id}</span>
                {s.agent && <span>{s.agent}</span>}
                {s.group_name && <span>{s.group_name}</span>}
                {s.repo && <span>{s.repo}</span>}
                <span>{relTime(s.updated_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
