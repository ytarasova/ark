import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { relTime } from "../util.js";
import { Card } from "./ui/card.js";
import { LayoutGrid } from "lucide-react";

const STATUS_BAR_COLORS: Record<string, string> = {
  running: "bg-emerald-400", waiting: "bg-amber-400", completed: "bg-blue-400",
  failed: "bg-red-400", stopped: "bg-muted-foreground/30", pending: "bg-muted-foreground/30",
  ready: "bg-muted-foreground/30", deleting: "bg-muted-foreground/20",
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  running: "text-emerald-400", waiting: "text-amber-400", completed: "text-blue-400",
  failed: "text-red-400", stopped: "text-muted-foreground", pending: "text-muted-foreground",
  ready: "text-muted-foreground", deleting: "text-muted-foreground",
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
        <LayoutGrid size={28} className="text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">Loading...</p>
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
        <div className="text-[40px] font-bold text-foreground font-mono">{total}</div>
        <div className="text-muted-foreground text-xs">Total Sessions</div>
      </div>

      {/* Status bar */}
      {total > 0 && (
        <div className="flex h-1 rounded-full overflow-hidden bg-secondary mb-5">
          {entries.map(([status, count]) => (
            <div
              key={status}
              className={cn("transition-[width] duration-300", STATUS_BAR_COLORS[status] || "bg-muted-foreground/30")}
              style={{ width: `${(count / total) * 100}%` }}
            />
          ))}
        </div>
      )}

      {/* Status cards */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2.5 mb-5">
        {entries.map(([status, count]) => (
          <Card key={status} className="p-4 text-center transition-colors hover:bg-accent hover:border-ring">
            <div className={cn("text-[28px] font-bold tracking-[-0.02em] leading-none font-mono", STATUS_TEXT_COLORS[status] || "text-muted-foreground")}>{count}</div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] mt-1.5 text-muted-foreground">{status}</div>
          </Card>
        ))}
      </div>

      {/* Recent sessions table */}
      {sessions && sessions.length > 0 && (
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            Recent Sessions
          </h3>
          <Card className="overflow-hidden">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card"></th>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card">Session</th>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card">Status</th>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card">Agent</th>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card">Updated</th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 15).map((s) => (
                  <tr key={s.id} className="hover:bg-accent transition-colors">
                    <td className="p-2.5 px-3 text-xs border-b border-border/50"><StatusDot status={s.status} /></td>
                    <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground">{s.summary || s.id}</td>
                    <td className="p-2.5 px-3 text-xs border-b border-border/50"><StatusBadge status={s.status} /></td>
                    <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground">{s.agent || "-"}</td>
                    <td className="p-2.5 px-3 text-[11px] border-b border-border/50 text-muted-foreground font-mono">{relTime(s.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}
