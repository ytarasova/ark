import { useMemo } from "react";
import { useCostsQuery } from "../hooks/useCostQueries.js";
import { fmtCost } from "../util.js";
import { Card } from "./ui/card.js";
import { DollarSign, TrendingUp, Activity, Info } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { useChartPalette, useModelColors, ChartTooltip, AXIS_TICK_STYLE } from "./ui/chart.js";

export function CostsView() {
  const { data: costs, isLoading } = useCostsQuery();
  const palette = useChartPalette();
  const modelColors = useModelColors();

  const sessions = costs?.sessions || [];

  // Aggregate by model
  const byModel = useMemo(() => {
    const map: Record<string, { cost: number; count: number; tokens: number }> = {};
    for (const s of sessions) {
      const m = s.model || "unknown";
      if (!map[m]) map[m] = { cost: 0, count: 0, tokens: 0 };
      map[m].cost += s.cost;
      map[m].count++;
      map[m].tokens += s.usage?.input_tokens ?? 0;
      map[m].tokens += s.usage?.output_tokens ?? 0;
    }
    return map;
  }, [sessions]);

  // Bar chart data: cost by model
  const modelBarData = useMemo(
    () =>
      Object.entries(byModel)
        .sort(([, a], [, b]) => b.cost - a.cost)
        .map(([model, data]) => ({
          name: model,
          cost: Math.round(data.cost * 100) / 100,
          fill: modelColors[model] ?? palette[0],
        })),
    [byModel, modelColors, palette],
  );

  const costFormatter = (val: number) => `$${val.toFixed(2)}`;

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-muted-foreground">Loading costs...</div>
      </div>
    );
  }

  // Empty state
  if (!costs || sessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="max-w-md text-center px-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-accent mb-4">
            <DollarSign size={22} className="text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-2">No cost data yet</h2>
          <p className="text-[13px] text-muted-foreground leading-relaxed mb-5">
            Cost tracking is automatic. As agents run, token usage and costs appear here.
          </p>
          <div className="rounded-lg border border-border bg-card p-4 text-left space-y-3 mb-5">
            <div className="flex items-start gap-3">
              <Activity size={14} className="text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-[12px] text-muted-foreground">
                Costs are tracked per-model. Run a session to see your first cost breakdown.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <TrendingUp size={14} className="text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-[12px] text-muted-foreground">
                Usage is broken down by model (Opus, Sonnet, Haiku) with token counts and dollar costs.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <Info size={14} className="text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-[12px] text-muted-foreground">Configure budget limits in Settings.</p>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground/60">0 sessions with recorded costs</p>
        </div>
      </div>
    );
  }

  // Populated state -- full-width cost dashboard
  return (
    <div className="overflow-y-auto h-full bg-background">
      <div className="p-5 max-w-[1200px] mx-auto space-y-5">
        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Card className="p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1">
              Total Spend
            </div>
            <div className="text-2xl font-bold font-mono text-[var(--running)] tracking-[-0.02em]">
              {fmtCost(costs.total || 0)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">{sessions.length} sessions with usage data</div>
          </Card>
          <Card className="p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1">
              Models Used
            </div>
            <div className="text-2xl font-bold font-mono text-foreground tracking-[-0.02em]">
              {Object.keys(byModel).length}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              {Object.entries(byModel)
                .sort(([, a], [, b]) => b.cost - a.cost)
                .map(([m]) => m)
                .join(", ")}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1">
              Avg Cost / Session
            </div>
            <div className="text-2xl font-bold font-mono text-foreground tracking-[-0.02em]">
              {fmtCost(sessions.length > 0 ? (costs.total || 0) / sessions.length : 0)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">across {sessions.length} sessions</div>
          </Card>
        </div>

        {/* Cost by model -- bar chart + breakdown cards side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Bar chart */}
          {modelBarData.length > 0 && (
            <Card className="p-4">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-3">
                Cost by Model
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={modelBarData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                  <XAxis dataKey="name" tick={AXIS_TICK_STYLE} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={AXIS_TICK_STYLE}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${v}`}
                    width={50}
                  />
                  <Tooltip content={<ChartTooltip formatter={costFormatter} />} />
                  <Bar dataKey="cost" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                    {modelBarData.map((entry, idx) => (
                      <Cell key={`cell-${idx}`} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
          )}

          {/* Model breakdown cards */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2.5 content-start">
            {Object.entries(byModel)
              .sort(([, a], [, b]) => b.cost - a.cost)
              .map(([model, data]) => (
                <Card key={model} className="p-4 transition-colors hover:bg-accent hover:border-ring">
                  <div className="font-medium text-[var(--waiting)] text-[10px] uppercase tracking-[0.04em] font-mono">
                    {model}
                  </div>
                  <div className="text-2xl font-bold text-foreground mt-1.5 tracking-[-0.02em] font-mono">
                    {fmtCost(data.cost)}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {data.count} session{data.count !== 1 ? "s" : ""}
                  </div>
                  {data.tokens > 0 && (
                    <div className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono">
                      {(data.tokens / 1000).toFixed(1)}k tokens
                    </div>
                  )}
                </Card>
              ))}
          </div>
        </div>

        {/* Cost per session table */}
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            Sessions by Cost
          </h3>
          <Card className="overflow-hidden">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card">
                    Session
                  </th>
                  <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card">
                    Model
                  </th>
                  <th className="text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card">
                    Tokens
                  </th>
                  <th className="text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border bg-card">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 30).map((s: any, i: number) => {
                  const totalTokens = (s.usage?.input_tokens ?? 0) + (s.usage?.output_tokens ?? 0);
                  return (
                    <tr key={i} className="hover:bg-accent transition-colors">
                      <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground truncate max-w-[300px]">
                        {s.summary || s.sessionId}
                      </td>
                      <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground font-mono">
                        {s.model || "-"}
                      </td>
                      <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-right text-muted-foreground font-mono">
                        {totalTokens > 0 ? `${(totalTokens / 1000).toFixed(1)}k` : "-"}
                      </td>
                      <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-right text-[var(--running)] font-semibold font-mono">
                        {fmtCost(s.cost)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          {sessions.length > 30 && (
            <p className="text-[11px] text-muted-foreground mt-2">
              Showing top 30 of {sessions.length} sessions by cost.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
