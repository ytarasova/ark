import { Card } from "../ui/card.js";
import { fmtCost } from "../../util.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

interface OverviewData {
  totalCostUsd: number;
  totalApiCalls: number;
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  cacheHitPct: number;
}

interface OverviewPanelProps {
  data: OverviewData;
}

export function OverviewPanel({ data }: OverviewPanelProps) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <span className="text-3xl font-bold font-mono text-amber-400">
          {fmtCost(data.totalCostUsd)}
        </span>
        <span className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{data.totalApiCalls.toLocaleString()}</span> calls
        </span>
        <span className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{data.totalSessions}</span> sessions
        </span>
        <span className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{data.cacheHitPct.toFixed(0)}%</span> cache hit
        </span>
      </div>
      <div className="mt-2 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
        <span>{formatTokens(data.totalInputTokens)} in</span>
        <span>{formatTokens(data.totalOutputTokens)} out</span>
        <span>{formatTokens(data.totalCacheReadTokens)} cached</span>
        <span>{formatTokens(data.totalCacheWriteTokens)} written</span>
      </div>
    </Card>
  );
}
