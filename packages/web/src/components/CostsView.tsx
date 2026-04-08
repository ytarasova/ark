import { useCostsQuery } from "../hooks/useQueries.js";
import { fmtCost } from "../util.js";
import { Card } from "./ui/card.js";
import { DollarSign } from "lucide-react";

export function CostsView() {
  const { data: costs } = useCostsQuery();

  if (!costs) return (
    <div className="flex items-center justify-center h-[calc(100vh-180px)]">
      <div className="text-center">
        <DollarSign size={28} className="text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">Loading costs...</p>
      </div>
    </div>
  );

  const byModel: Record<string, { cost: number; count: number }> = {};
  for (const s of costs.sessions || []) {
    const m = s.model || "unknown";
    if (!byModel[m]) byModel[m] = { cost: 0, count: 0 };
    byModel[m].cost += s.cost;
    byModel[m].count++;
  }

  return (
    <div>
      {/* Hero cost */}
      <div className="text-center py-10">
        <div className="text-4xl font-bold font-mono text-emerald-400">{fmtCost(costs.total || 0)}</div>
        <div className="text-sm text-muted-foreground mt-1">{(costs.sessions || []).length} sessions with usage data</div>
      </div>

      {/* Cost by model cards */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5 mb-5">
        {Object.entries(byModel).map(([model, data]) => (
          <Card key={model} className="p-4 transition-colors hover:bg-accent hover:border-ring">
            <div className="font-medium text-amber-400 text-[10px] uppercase tracking-[0.04em] font-mono">{model}</div>
            <div className="text-2xl font-bold text-foreground mt-1.5 tracking-[-0.02em] font-mono">{fmtCost(data.cost)}</div>
            <div className="text-xs text-muted-foreground mt-1">{data.count} sessions</div>
          </Card>
        ))}
      </div>

      {/* Top sessions table */}
      {(costs.sessions || []).length > 0 && (
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            Top Sessions by Cost
          </h3>
          <Card className="overflow-hidden">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card">Session</th>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card">Model</th>
                  <th className="text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card">Cost</th>
                </tr>
              </thead>
              <tbody>
                {(costs.sessions || []).slice(0, 20).map((s: any, i: number) => (
                  <tr key={i} className="hover:bg-accent transition-colors">
                    <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground">{s.summary || s.sessionId}</td>
                    <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground">{s.model || "-"}</td>
                    <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-right text-emerald-400 font-semibold font-mono">{fmtCost(s.cost)}</td>
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
