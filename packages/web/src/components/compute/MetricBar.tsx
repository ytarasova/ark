import { cn } from "../../lib/utils.js";
import { pctBarClass } from "./helpers.js";

export function MetricBar({ value, total, unit, pct }: { value: string; total?: string; unit?: string; pct: number }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[12px]">
        <span className="font-mono text-foreground font-medium">
          {value}
          {total ? ` / ${total}` : ""}
          {unit ? ` ${unit}` : ""}
        </span>
        <span className="text-muted-foreground">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", pctBarClass(pct))}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}
