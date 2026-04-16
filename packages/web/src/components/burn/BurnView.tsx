import { useState } from "react";
import { useBurnSummary, type BurnPeriod } from "../../hooks/useBurnQueries.js";
import { Card } from "../ui/card.js";
import { BurnPeriodTabs } from "./BurnPeriodTabs.js";
import { BurnSyncButton } from "./BurnSyncButton.js";
import { OverviewPanel } from "./OverviewPanel.js";
import { DailyActivityPanel } from "./DailyActivityPanel.js";
import { ByProjectPanel } from "./ByProjectPanel.js";
import { ByModelPanel } from "./ByModelPanel.js";
import { ByActivityPanel } from "./ByActivityPanel.js";
import { CoreToolsPanel } from "./CoreToolsPanel.js";
import { ShellCommandsPanel } from "./ShellCommandsPanel.js";
import { McpServersPanel } from "./McpServersPanel.js";

function SkeletonCard({ className }: { className?: string }) {
  return (
    <Card className={className}>
      <div className="p-4 space-y-3">
        <div className="h-3 w-24 animate-pulse bg-accent rounded" />
        <div className="h-20 animate-pulse bg-accent rounded" />
        <div className="h-3 w-32 animate-pulse bg-accent rounded" />
      </div>
    </Card>
  );
}

export function BurnView() {
  const [period, setPeriod] = useState<BurnPeriod>("week");
  const { data, isLoading, isError, error, refetch } = useBurnSummary(period);

  // Loading state
  if (isLoading) {
    return (
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <BurnPeriodTabs active={period} onChange={setPeriod} />
          <BurnSyncButton />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <SkeletonCard className="md:col-span-2 xl:col-span-3" />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  // Error state
  if (isError) {
    return (
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <BurnPeriodTabs active={period} onChange={setPeriod} />
          <BurnSyncButton />
        </div>
        <div className="flex flex-col items-center justify-center py-20 text-sm text-muted-foreground">
          <p className="text-red-400 mb-2">Failed to load burn data</p>
          <p className="text-xs mb-4">{(error as Error)?.message ?? "Unknown error"}</p>
          <button
            onClick={() => refetch()}
            className="px-3 py-1.5 rounded-md text-[12px] bg-accent text-foreground hover:bg-accent/80 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Empty state
  if (!data || !data.overview) {
    return (
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <BurnPeriodTabs active={period} onChange={setPeriod} />
          <BurnSyncButton />
        </div>
        <div className="flex flex-col items-center justify-center py-20 text-sm text-muted-foreground">
          <p className="mb-4">No burn data yet</p>
          <BurnSyncButton />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <BurnPeriodTabs active={period} onChange={setPeriod} />
        <BurnSyncButton />
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {/* Row 1: Overview (full width) */}
        <div className="md:col-span-2 xl:col-span-3">
          <OverviewPanel data={data.overview} />
        </div>

        {/* Row 2: Daily Activity | By Project */}
        <DailyActivityPanel data={data.daily ?? []} />
        <ByProjectPanel data={data.byProject ?? []} />

        {/* Row 3: By Model | By Activity */}
        <ByModelPanel data={data.byModel ?? []} />
        <ByActivityPanel data={data.byCategory ?? []} />

        {/* Row 4: Core Tools | Shell Commands | MCP Servers */}
        <CoreToolsPanel data={data.coreTools ?? []} hasData={data.runtimeCoverage?.hasToolData !== false} />
        <ShellCommandsPanel data={data.bashCommands ?? []} hasData={data.runtimeCoverage?.hasBashData !== false} />
        <McpServersPanel data={data.mcpServers ?? []} hasData={data.runtimeCoverage?.hasMcpData !== false} />
      </div>
    </div>
  );
}
