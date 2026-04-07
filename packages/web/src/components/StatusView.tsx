import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { relTime } from "../util.js";
import { LayoutGrid } from "lucide-react";

const STATUS_BAR_COLORS: Record<string, string> = {
  running: "bg-emerald-400", waiting: "bg-amber-400", completed: "bg-blue-400",
  failed: "bg-red-400", stopped: "bg-white/20", pending: "bg-white/20",
  ready: "bg-white/20", deleting: "bg-white/15",
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  running: "text-emerald-400", waiting: "text-amber-400", completed: "text-blue-400",
  failed: "text-red-400", stopped: "text-white/35", pending: "text-white/35",
  ready: "text-white/35", deleting: "text-white/25",
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

  if (!statusData) return (
    <div className="flex items-center justify-center h-[calc(100vh-180px)]">
      <div className="text-center">
        <LayoutGrid size={28} className="text-white/15 mx-auto mb-3" />
        <p className="text-sm text-white/35">Loading...</p>
      </div>
    </div>
  );

  const entries: [string, number][] = Object.entries(statusData.byStatus || {}).sort(
    ([, a], [, b]) => b - a
  );
  const total = statusData.total || 0;

  return (
    <div>
      {/* Hero total */}
      <div className="text-center mb-5">
        <div className="text-[40px] font-bold text-white/90 font-mono">{total}</div>
        <div className="text-white/35 text-xs">Total Sessions</div>
      </div>

      {/* Status bar */}
      {total > 0 && (
        <div className="flex h-1 rounded-full overflow-hidden bg-white/[0.04] mb-5">
          {entries.map(([status, count]) => (
            <div
              key={status}
              className={cn("transition-[width] duration-300", STATUS_BAR_COLORS[status] || "bg-white/20")}
              style={{ width: `${(count / total) * 100}%` }}
            />
          ))}
        </div>
      )}

      {/* Status cards */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2.5 mb-5">
        {entries.map(([status, count]) => (
          <div key={status} className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4 text-center transition-colors hover:bg-white/[0.04] hover:border-white/[0.1]">
            <div className={cn("text-[28px] font-bold tracking-[-0.02em] leading-none font-mono", STATUS_TEXT_COLORS[status] || "text-white/35")}>{count}</div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] mt-1.5 text-white/35">{status}</div>
          </div>
        ))}
      </div>

      {/* Recent sessions table */}
      {sessions && sessions.length > 0 && (
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">
            Recent Sessions
          </h3>
          <div className="rounded-lg border border-white/[0.06] overflow-hidden">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 p-2 px-3 border-b border-white/[0.06] bg-white/[0.02]"></th>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 p-2 px-3 border-b border-white/[0.06] bg-white/[0.02]">Session</th>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 p-2 px-3 border-b border-white/[0.06] bg-white/[0.02]">Status</th>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 p-2 px-3 border-b border-white/[0.06] bg-white/[0.02]">Agent</th>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 p-2 px-3 border-b border-white/[0.06] bg-white/[0.02]">Updated</th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 15).map((s) => (
                  <tr key={s.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-2.5 px-3 text-xs border-b border-white/[0.03]"><StatusDot status={s.status} /></td>
                    <td className="p-2.5 px-3 text-[13px] border-b border-white/[0.03] text-white/60">{s.summary || s.id}</td>
                    <td className="p-2.5 px-3 text-xs border-b border-white/[0.03]"><StatusBadge status={s.status} /></td>
                    <td className="p-2.5 px-3 text-[13px] border-b border-white/[0.03] text-white/60">{s.agent || "-"}</td>
                    <td className="p-2.5 px-3 text-[11px] border-b border-white/[0.03] text-white/25 font-mono">{relTime(s.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
