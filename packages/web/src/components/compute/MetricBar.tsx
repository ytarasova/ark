import { cn } from "../../lib/utils.js";
import { pctBarClass } from "./helpers.js";

export function MetricBar({ value, total, unit, pct }: { value: string; total?: string; unit?: string; pct: number }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-foreground font-medium tabular-nums font-[family-name:var(--font-mono-ui)]">
          {value}
          {total ? ` / ${total}` : ""}
          {unit ? ` ${unit}` : ""}
        </span>
        <span className="text-muted-foreground tabular-nums font-[family-name:var(--font-mono-ui)]">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
            pctBarClass(pct),
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}
