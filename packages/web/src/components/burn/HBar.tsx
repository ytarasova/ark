import {
  BarChart, Bar, XAxis, YAxis, Cell, ResponsiveContainer, Tooltip,
} from "recharts";
import { Card } from "../ui/card.js";

// Blue -> amber -> orange gradient
function gradientColor(pct: number): string {
  function lerp(a: number, b: number, t: number) { return a + t * (b - a); }
  function toHex(r: number, g: number, b: number) {
    return "#" + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
  }
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

interface HBarProps {
  data: Array<{ name: string; value: number }>;
  maxItems?: number;
  valueFormatter?: (v: number) => string;
}

export function HBar({ data, maxItems = 10, valueFormatter }: HBarProps) {
  const items = data.slice(0, maxItems);
  if (items.length === 0) return null;

  const fmt = valueFormatter ?? ((v: number) => String(v));
  const height = Math.max(120, items.length * 28 + 20);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        layout="vertical"
        data={items}
        margin={{ top: 0, right: 12, left: 0, bottom: 0 }}
      >
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          width={100}
          tickFormatter={(v: string) => v.length > 14 ? v.slice(0, 13) + "\u2026" : v}
        />
        <Tooltip
          formatter={(val: number) => fmt(val)}
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
            fontSize: "12px",
          }}
          itemStyle={{ color: "hsl(var(--foreground))" }}
          cursor={{ fill: "hsl(var(--accent))", opacity: 0.3 }}
        />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={16}>
          {items.map((_entry, idx) => (
            <Cell key={idx} fill={gradientColor(idx / Math.max(items.length - 1, 1))} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
