import { useState, useMemo } from "react";
import { useCostsQuery } from "../hooks/useCostQueries.js";
import { fmtCost } from "../util.js";
import { cn } from "../lib/utils.js";
import { Card } from "./ui/card.js";
import { DollarSign } from "lucide-react";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useChartPalette, useModelColors, ChartTooltip, AXIS_TICK_STYLE } from "./ui/chart.js";

export function CostsView() {
  const { data: costs } = useCostsQuery();
  const [selected, setSelected] = useState<any>(null);
  const palette = useChartPalette();
  const modelColors = useModelColors();

  const sessions = costs?.sessions || [];

  const byModel: Record<string, { cost: number; count: number }> = {};
  for (const s of sessions) {
    const m = s.model || "unknown";
    if (!byModel[m]) byModel[m] = { cost: 0, count: 0 };
    byModel[m].cost += s.cost;
    byModel[m].count++;
  }

  // Chart data: cost by model (pie)
  const pieData = useMemo(
    () =>
      Object.entries(byModel).map(([model, data], idx) => ({
        name: model,
        value: Math.round(data.cost * 100) / 100,
        fill: modelColors[model] ?? palette[idx % palette.length],
      })),
    [sessions, modelColors, palette],
  );

  // Chart data: top 10 sessions by cost (bar)
  const barData = useMemo(
    () =>
      sessions.slice(0, 10).map((s: any) => ({
        name: (s.summary || s.sessionId || "").slice(0, 20),
        cost: Math.round(s.cost * 100) / 100,
        model: s.model || "unknown",
      })),
    [sessions],
  );

  const costFormatter = (val: number) => `$${val.toFixed(2)}`;

  return (
    <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
      {/* Left: session cost list */}
      <div className="border-r border-border overflow-y-auto">
        {/* Loading state */}
        {!costs && (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <DollarSign size={20} className="text-muted-foreground/30 mb-2" />
            <p className="text-[11px] text-muted-foreground">Loading costs...</p>
          </div>
        )}

        {/* Empty state */}
        {costs && sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <DollarSign size={20} className="text-muted-foreground/30 mb-2" />
            <p className="text-[11px] text-muted-foreground text-center">No cost data</p>
          </div>
        )}

        {/* Session list */}
        {sessions.map((s: any, i: number) => (
          <div
            key={i}
            className={cn(
              "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors",
              "hover:bg-accent",
              selected === s && "bg-accent border-l-2 border-l-primary",
            )}
            onClick={() => setSelected(s)}
          >
            <span className="text-[12px] text-foreground truncate leading-snug min-w-0">
              {s.summary || s.sessionId}
            </span>
            <span className="text-[11px] text-[var(--running)] font-mono font-semibold shrink-0 ml-2">
              {fmtCost(s.cost)}
            </span>
          </div>
        ))}
      </div>

      {/* Right: detail panel */}
      <div className="overflow-y-auto bg-background">
        {selected ? (
          /* Selected session cost detail */
          <div className="p-5">
            <h2 className="text-lg font-semibold text-foreground mb-1">{selected.summary || selected.sessionId}</h2>
            <div className="mb-4">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                Cost Details
              </h3>
              <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                <span className="text-muted-foreground">Session</span>
                <span className="text-card-foreground font-mono">{selected.sessionId}</span>
                <span className="text-muted-foreground">Model</span>
                <span className="text-card-foreground">{selected.model || "-"}</span>
                <span className="text-muted-foreground">Cost</span>
                <span className="text-[var(--running)] font-semibold font-mono">{fmtCost(selected.cost)}</span>
              </div>
            </div>
          </div>
        ) : (
          /* Summary dashboard */
          <div className="p-5">
            {/* Hero cost */}
            {costs && (
              <>
                <div className="text-center py-8">
                  <div className="text-4xl font-bold font-mono text-[var(--running)]">{fmtCost(costs.total || 0)}</div>
                  <div className="text-sm text-muted-foreground mt-1">{sessions.length} sessions with usage data</div>
                </div>

                {/* Charts */}
                {sessions.length > 0 && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
                    {/* Pie: cost by model */}
                    {pieData.length > 0 && (
                      <Card className="p-4">
                        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-3">
                          Cost by Model
                        </h3>
                        <ResponsiveContainer width="100%" height={200}>
                          <PieChart>
                            <Pie
                              data={pieData}
                              cx="50%"
                              cy="50%"
                              innerRadius={50}
                              outerRadius={80}
                              dataKey="value"
                              isAnimationActive={false}
                              label={({ name, value }) => `${name}: $${value.toFixed(2)}`}
                              labelLine={false}
                              stroke="none"
                            >
                              {pieData.map((entry, idx) => (
                                <Cell key={`cell-${idx}`} fill={entry.fill} />
                              ))}
                            </Pie>
                            <Tooltip content={<ChartTooltip formatter={costFormatter} />} />
                          </PieChart>
                        </ResponsiveContainer>
                        {/* Inline legend matching app typography */}
                        <div className="flex flex-wrap gap-3 mt-2">
                          {pieData.map((entry) => (
                            <div key={entry.name} className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: entry.fill }} />
                              <span className="text-[11px] text-muted-foreground font-mono">{entry.name}</span>
                            </div>
                          ))}
                        </div>
                      </Card>
                    )}

                    {/* Bar: top sessions by cost */}
                    {barData.length > 0 && (
                      <Card className="p-4">
                        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-3">
                          Top Sessions by Cost
                        </h3>
                        <ResponsiveContainer width="100%" height={200}>
                          <BarChart data={barData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                            <XAxis
                              dataKey="name"
                              tick={{ ...AXIS_TICK_STYLE, fontSize: 9 }}
                              tickLine={false}
                              axisLine={false}
                              interval={0}
                              angle={-30}
                              textAnchor="end"
                              height={50}
                            />
                            <YAxis
                              tick={AXIS_TICK_STYLE}
                              tickLine={false}
                              axisLine={false}
                              tickFormatter={(v) => `$${v}`}
                              width={50}
                            />
                            <Tooltip content={<ChartTooltip formatter={costFormatter} />} />
                            <Bar dataKey="cost" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                              {barData.map((entry, idx) => (
                                <Cell
                                  key={`bar-${idx}`}
                                  fill={modelColors[entry.model] ?? palette[idx % palette.length]}
                                />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </Card>
                    )}
                  </div>
                )}

                {/* Cost by model cards */}
                {Object.keys(byModel).length > 0 && (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5 mb-5">
                    {Object.entries(byModel).map(([model, data]) => (
                      <Card key={model} className="p-4 transition-colors hover:bg-accent hover:border-ring">
                        <div className="font-medium text-[var(--waiting)] text-[10px] uppercase tracking-[0.04em] font-mono">
                          {model}
                        </div>
                        <div className="text-2xl font-bold text-foreground mt-1.5 tracking-[-0.02em] font-mono">
                          {fmtCost(data.cost)}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">{data.count} sessions</div>
                      </Card>
                    ))}
                  </div>
                )}

                {/* Top sessions table */}
                {sessions.length > 0 && (
                  <div>
                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                      Top Sessions by Cost
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
                              Cost
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {sessions.slice(0, 20).map((s: any, i: number) => (
                            <tr
                              key={i}
                              className="hover:bg-accent transition-colors cursor-pointer"
                              onClick={() => setSelected(s)}
                            >
                              <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground">
                                {s.summary || s.sessionId}
                              </td>
                              <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground">
                                {s.model || "-"}
                              </td>
                              <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-right text-[var(--running)] font-semibold font-mono">
                                {fmtCost(s.cost)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Card>
                  </div>
                )}
              </>
            )}

            {/* Loading / no data fallback */}
            {!costs && (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                Loading costs...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
