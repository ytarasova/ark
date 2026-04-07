import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { relTime } from "../util.js";

const STATUS_COLORS: Record<string, string> = {
  running: "var(--green)", waiting: "var(--yellow)", completed: "var(--blue)",
  failed: "var(--red)", stopped: "var(--label-quaternary)", pending: "var(--label-quaternary)",
  ready: "var(--label-quaternary)", deleting: "var(--label-quaternary)",
};

interface StatusData {
  byStatus: Record<string, number>;
  total: number;
}

interface SessionSummary {
  id: string;
  status: string;
  summary?: string;
  agent?: string;
  updated_at?: string;
}

export function StatusView({ sessions }: { sessions: SessionSummary[] }) {
  const [statusData, setStatusData] = useState<StatusData | null>(null);

  useEffect(() => {
    api.getStatus().then(setStatusData);
  }, []);

  if (!statusData) return <div className="empty"><div className="empty-text">Loading...</div></div>;

  const entries: [string, number][] = Object.entries(statusData.byStatus || {}).sort(
    ([, a], [, b]) => b - a
  );
  const total = statusData.total || 0;

  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 40, fontWeight: 700, color: "var(--label)", fontFamily: "var(--mono)" }}>{total}</div>
        <div style={{ color: "var(--label-tertiary)", fontSize: 12 }}>Total Sessions</div>
      </div>
      {/* Status bar */}
      {total > 0 && (
        <div className="status-bar-row">
          {entries.map(([status, count]) => (
            <div
              key={status}
              className="status-bar-segment"
              style={{ width: `${(count / total) * 100}%`, background: STATUS_COLORS[status] || "var(--label-quaternary)" }}
            />
          ))}
        </div>
      )}
      {/* Cards */}
      <div className="status-grid">
        {entries.map(([status, count]) => (
          <div key={status} className="status-card">
            <div className="status-count" style={{ color: STATUS_COLORS[status] || "var(--label-tertiary)" }}>{count}</div>
            <div className="status-label">{status}</div>
          </div>
        ))}
      </div>
      {/* Recent sessions */}
      {sessions && sessions.length > 0 && (
        <div>
          <div style={{ color: "var(--label-quaternary)", fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 8 }}>
            Recent Sessions
          </div>
          <table className="table">
            <thead>
              <tr>
                <th></th>
                <th>Session</th>
                <th>Status</th>
                <th>Agent</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {sessions.slice(0, 15).map((s) => (
                <tr key={s.id}>
                  <td><StatusDot status={s.status} /></td>
                  <td>{s.summary || s.id}</td>
                  <td><StatusBadge status={s.status} /></td>
                  <td>{s.agent || "-"}</td>
                  <td style={{ color: "var(--label-quaternary)", fontFamily: "var(--mono)", fontSize: 11 }}>{relTime(s.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
