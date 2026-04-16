import { Card } from "../ui/card.js";
import { fmtCost } from "../../util.js";
import { cn } from "../../lib/utils.js";

const CATEGORY_LABELS: Record<string, string> = {
  coding: "Coding",
  debugging: "Debugging",
  feature: "Feature Dev",
  refactoring: "Refactoring",
  testing: "Testing",
  exploration: "Exploration",
  planning: "Planning",
  delegation: "Delegation",
  git: "Git Ops",
  "build/deploy": "Build/Deploy",
  conversation: "Conversation",
  brainstorming: "Brainstorming",
  general: "General",
};

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

interface CategoryEntry {
  category: string;
  cost: number;
  turns: number;
  oneShotPct: number | null;
  editTurns: number;
}

interface ByActivityPanelProps {
  data: CategoryEntry[];
}

export function ByActivityPanel({ data }: ByActivityPanelProps) {
  const sorted = [...data].sort((a, b) => b.cost - a.cost);
  const maxCost = sorted[0]?.cost ?? 0;

  return (
    <Card className="p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-400 mb-3">
        By Activity
      </h3>
      {sorted.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
          No activity data
        </div>
      ) : (
        <div className="space-y-1">
          {/* Header */}
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 text-[10px] text-muted-foreground uppercase tracking-wide px-1 pb-1">
            <span />
            <span className="w-14 text-right">Category</span>
            <span className="w-16 text-right">Cost</span>
            <span className="w-12 text-right">Turns</span>
            <span className="w-14 text-right">1-shot</span>
          </div>
          {sorted.map((entry, idx) => {
            const barPct = maxCost > 0 ? (entry.cost / maxCost) * 100 : 0;
            const color = gradientColor(idx / Math.max(sorted.length - 1, 1));
            const label = CATEGORY_LABELS[entry.category] ?? entry.category;
            const oneShotDisplay = entry.oneShotPct === null ? "--" : `${Math.round(entry.oneShotPct)}%`;
            const oneShotColor = entry.oneShotPct === null
              ? "text-muted-foreground"
              : entry.oneShotPct >= 80
                ? "text-emerald-400 font-bold"
                : entry.oneShotPct >= 50
                  ? "text-amber-400 font-bold"
                  : "text-red-400 font-bold";

            return (
              <div
                key={entry.category}
                className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 items-center px-1 py-0.5"
              >
                {/* Bar */}
                <div className="h-4 rounded-sm overflow-hidden bg-accent/30">
                  <div
                    className="h-full rounded-sm transition-all"
                    style={{ width: `${barPct}%`, backgroundColor: color }}
                  />
                </div>
                {/* Category label */}
                <span className="w-14 text-right text-[11px] text-foreground truncate" title={label}>
                  {label}
                </span>
                {/* Cost */}
                <span className="w-16 text-right text-[11px] font-mono text-amber-400">
                  {fmtCost(entry.cost)}
                </span>
                {/* Turns */}
                <span className="w-12 text-right text-[11px] text-muted-foreground">
                  {entry.turns}
                </span>
                {/* 1-shot % */}
                <span className={cn("w-14 text-right text-[11px]", oneShotColor)}>
                  {oneShotDisplay}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
