import { Card } from "../ui/card.js";
import { fmtCost } from "../../util.js";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";

// Blue -> amber -> orange gradient (same as HBar)
function barColor(idx: number, total: number): string {
  function lerp(a: number, b: number, t: number) { return a + t * (b - a); }
  function toHex(r: number, g: number, b: number) {
    return "#" + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
  }
  const pct = total <= 1 ? 0.5 : idx / (total - 1);
  if (pct <= 0.33) {
    const t = pct / 0.33;
    return toHex(lerp(91, 245, t), lerp(158, 200, t), lerp(245, 91, t));
  }
  if (pct <= 0.66) {
    const t = (pct - 0.33) / 0.33;
    return toHex(lerp(245, 255, t), lerp(200, 140, t), lerp(91, 66, t));
  }
  const t = (pct - 0.66) / 0.34;
  return toHex(lerp(255, 245, t), lerp(140, 91, t), lerp(66, 91, t));
}

interface DailyEntry {
  date: string;
  cost: number;
  calls: number;
}

interface DailyActivityPanelProps {
  data: DailyEntry[];
}

export function DailyActivityPanel({ data }: DailyActivityPanelProps) {
  const chartData = data.map(d => ({
    ...d,
    label: d.date.slice(5), // MM-DD
  }));

  return (
    <Card className="p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-400 mb-3">
        Daily Activity
      </h3>
      {chartData.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
          No daily data
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              interval={0}
              angle={-30}
              textAnchor="end"
              height={40}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `$${v}`}
              width={50}
            />
            <Tooltip
              formatter={(val: number) => fmtCost(val)}
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              itemStyle={{ color: "hsl(var(--foreground))" }}
            />
            <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
              {chartData.map((_entry, idx) => (
                <Cell key={idx} fill={barColor(idx, chartData.length)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
