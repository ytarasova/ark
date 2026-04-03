import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { relTime } from "../util.js";

const STATUS_COLORS: Record<string, string> = {
  running: "#9ece6a", waiting: "#e0af68", completed: "#7aa2f7",
  failed: "#f7768e", stopped: "#787fa0", pending: "#787fa0",
  ready: "#787fa0", deleting: "#565f89",
};

export function StatusView({ sessions }: { sessions: any[] }) {
  const [statusData, setStatusData] = useState<any>(null);

  useEffect(() => {
    api.getStatus().then(setStatusData);
  }, []);

  if (!statusData) return <div className="empty">Loading...</div>;

  const entries: [string, number][] = Object.entries(statusData.byStatus || {}).sort(
    (a: any, b: any) => b[1] - a[1]
  ) as any;
  const total = statusData.total || 0;

  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ fontSize: 48, fontWeight: 700, color: "#c0caf5" }}>{total}</div>
        <div style={{ color: "#787fa0", fontSize: 14 }}>Total Sessions</div>
      </div>
      {/* Status bar */}
      {total > 0 && (
        <div className="status-bar-row">
          {entries.map(([status, count]) => (
            <div
              key={status}
              className="status-bar-segment"
              style={{ width: `${(count / total) * 100}%`, background: STATUS_COLORS[status] || "#565f89" }}
            />
          ))}
        </div>
      )}
      {/* Cards */}
      <div className="status-grid">
        {entries.map(([status, count]) => (
          <div key={status} className="status-card">
            <div className="status-count" style={{ color: STATUS_COLORS[status] || "#787fa0" }}>{count}</div>
            <div className="status-label" style={{ color: "#787fa0" }}>{status}</div>
          </div>
        ))}
      </div>
      {/* Recent sessions */}
      {sessions && sessions.length > 0 && (
        <div>
          <h3 style={{ color: "#787fa0", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 12 }}>
            Recent Sessions
          </h3>
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
              {sessions.slice(0, 15).map((s: any) => (
                <tr key={s.id}>
                  <td><StatusDot status={s.status} /></td>
                  <td>{s.summary || s.id}</td>
                  <td><StatusBadge status={s.status} /></td>
                  <td>{s.agent || "-"}</td>
                  <td style={{ color: "#787fa0" }}>{relTime(s.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
