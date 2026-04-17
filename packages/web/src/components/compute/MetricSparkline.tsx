import { AreaChart, Area, ResponsiveContainer, Tooltip } from "recharts";
import { ChartTooltip } from "../ui/chart.js";
import type { MetricHistoryPoint } from "./types.js";

export function MetricSparkline({
  history,
  dataKey,
  gradientId,
  color,
}: {
  history: MetricHistoryPoint[];
  dataKey: string;
  gradientId: string;
  color: string;
}) {
  if (history.length < 2) return null;
  return (
    <div className="h-[60px] w-full mt-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={history} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Tooltip content={<ChartTooltip formatter={(v: number) => `${v}%`} />} />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
