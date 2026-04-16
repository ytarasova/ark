import { cn } from "../../lib/utils.js";
import type { BurnPeriod } from "../../hooks/useBurnQueries.js";

const PERIODS = [
  { key: "today" as const, label: "Today" },
  { key: "week" as const, label: "7 Days" },
  { key: "30days" as const, label: "30 Days" },
  { key: "month" as const, label: "Month" },
];

interface BurnPeriodTabsProps {
  active: BurnPeriod;
  onChange: (period: BurnPeriod) => void;
}

export function BurnPeriodTabs({ active, onChange }: BurnPeriodTabsProps) {
  return (
    <div className="flex gap-1">
      {PERIODS.map(p => (
        <button
          key={p.key}
          onClick={() => onChange(p.key)}
          className={cn(
            "px-3 py-1.5 rounded-md text-[12px] transition-colors",
            active === p.key
              ? "bg-accent text-foreground font-semibold"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
