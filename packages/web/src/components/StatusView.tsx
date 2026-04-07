import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { relTime } from "../util.js";

const STATUS_BG_CLASSES: Record<string, string> = {
  running: "bg-success", waiting: "bg-warning", completed: "bg-info",
  failed: "bg-danger", stopped: "bg-label-quaternary", pending: "bg-label-quaternary",
  ready: "bg-label-quaternary", deleting: "bg-label-quaternary",
};

const STATUS_TEXT_CLASSES: Record<string, string> = {
  running: "text-success", waiting: "text-warning", completed: "text-info",
  failed: "text-danger", stopped: "text-label-tertiary", pending: "text-label-tertiary",
  ready: "text-label-tertiary", deleting: "text-label-tertiary",
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

  if (!statusData) return <div className="text-center py-16 px-6 text-label-tertiary"><div className="text-[13px]">Loading...</div></div>;

  const entries: [string, number][] = Object.entries(statusData.byStatus || {}).sort(
    ([, a], [, b]) => b - a
  );
  const total = statusData.total || 0;

  return (
    <div>
      <div className="text-center mb-5">
        <div className="text-[40px] font-bold text-label font-mono">{total}</div>
        <div className="text-label-tertiary text-xs">Total Sessions</div>
      </div>
      {/* Status bar */}
      {total > 0 && (
        <div className="flex h-1 rounded-full overflow-hidden bg-surface-0 mb-5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)]">
          {entries.map(([status, count]) => (
            <div
              key={status}
              className={`transition-[width] duration-300 ${STATUS_BG_CLASSES[status] || "bg-label-quaternary"}`}
              style={{ width: `${(count / total) * 100}%` }}
            />
          ))}
        </div>
      )}
      {/* Cards */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2.5 mb-5">
        {entries.map(([status, count]) => (
          <div key={status} className="glass-card glass-shine-subtle rounded-xl p-4 text-center transition-all duration-200 hover:bg-surface-1 hover:border-white/15">
            <div className={`text-[28px] font-bold tracking-[-0.02em] leading-none font-mono ${STATUS_TEXT_CLASSES[status] || "text-label-tertiary"}`}>{count}</div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] mt-1.5 text-label-tertiary">{status}</div>
          </div>
        ))}
      </div>
      {/* Recent sessions */}
      {sessions && sessions.length > 0 && (
        <div>
          <div className="text-label-quaternary text-[10px] font-semibold uppercase tracking-[0.06em] mb-2">
            Recent Sessions
          </div>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]"></th>
                <th className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]">Session</th>
                <th className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]">Status</th>
                <th className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]">Agent</th>
                <th className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]">Updated</th>
              </tr>
            </thead>
            <tbody>
              {sessions.slice(0, 15).map((s) => (
                <tr key={s.id} className="hover:bg-white/3 transition-colors">
                  <td className="p-2.5 px-3.5 text-xs border-b border-white/4"><StatusDot status={s.status} /></td>
                  <td className="p-2.5 px-3.5 text-xs border-b border-white/4 text-label-secondary">{s.summary || s.id}</td>
                  <td className="p-2.5 px-3.5 text-xs border-b border-white/4"><StatusBadge status={s.status} /></td>
                  <td className="p-2.5 px-3.5 text-xs border-b border-white/4 text-label-secondary">{s.agent || "-"}</td>
                  <td className="p-2.5 px-3.5 text-xs border-b border-white/4 text-label-quaternary font-mono text-[11px]">{relTime(s.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
