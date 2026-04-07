import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { fmtCost } from "../util.js";

export function CostsView() {
  const [costs, setCosts] = useState<any>(null);

  useEffect(() => {
    api.getCosts().then(setCosts);
  }, []);

  if (!costs) return <div className="text-center py-16 px-6 text-label-tertiary"><div className="text-[13px]">Loading costs...</div></div>;

  const byModel: Record<string, { cost: number; count: number }> = {};
  for (const s of costs.sessions || []) {
    const m = s.model || "unknown";
    if (!byModel[m]) byModel[m] = { cost: 0, count: 0 };
    byModel[m].cost += s.cost;
    byModel[m].count++;
  }

  return (
    <div>
      <div className="text-center py-8">
        <div className="text-[44px] font-bold font-mono text-success drop-shadow-[0_0_30px_rgba(50,213,131,0.3)] leading-tight tracking-[-0.03em]">{fmtCost(costs.total || 0)}</div>
        <div className="text-label-tertiary text-[13px] mt-1.5">{(costs.sessions || []).length} sessions with usage data</div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5 mb-5">
        {Object.entries(byModel).map(([model, data]) => (
          <div key={model} className="glass-card glass-shine-subtle rounded-xl p-4 transition-all duration-200 hover:bg-surface-1 hover:border-white/15">
            <div className="font-medium text-warning text-[10px] uppercase tracking-[0.04em] font-mono">{model}</div>
            <div className="text-2xl font-bold text-label mt-1.5 tracking-[-0.02em] font-mono">{fmtCost(data.cost)}</div>
            <div className="text-xs text-label-tertiary mt-1">{data.count} sessions</div>
          </div>
        ))}
      </div>
      {(costs.sessions || []).length > 0 && (
        <div>
          <div className="text-label-quaternary text-[10px] font-semibold uppercase tracking-[0.06em] mb-2">
            Top Sessions by Cost
          </div>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]">Session</th>
                <th className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]">Model</th>
                <th className="text-right text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]">Cost</th>
              </tr>
            </thead>
            <tbody>
              {(costs.sessions || []).slice(0, 20).map((s: any, i: number) => (
                <tr key={i} className="hover:bg-white/3 transition-colors">
                  <td className="p-2.5 px-3.5 text-xs border-b border-white/4 text-label-secondary">{s.summary || s.sessionId}</td>
                  <td className="p-2.5 px-3.5 text-xs border-b border-white/4 text-label-secondary">{s.model || "-"}</td>
                  <td className="p-2.5 px-3.5 text-xs border-b border-white/4 text-right text-success font-semibold font-mono">{fmtCost(s.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
