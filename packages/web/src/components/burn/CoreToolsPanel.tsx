import { Card } from "../ui/card.js";
import { HBar } from "./HBar.js";

interface CoreToolsPanelProps {
  data: Array<{ tool: string; calls: number }>;
  hasData?: boolean;
}

export function CoreToolsPanel({ data, hasData }: CoreToolsPanelProps) {
  const items = data.slice(0, 10).map(t => ({
    name: t.tool,
    value: t.calls,
  }));

  return (
    <Card className="p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cyan-400 mb-3">
        Core Tools
      </h3>
      {hasData === false ? (
        <div className="text-sm text-muted-foreground text-center py-6">
          Tool usage data not available for some runtimes
        </div>
      ) : items.length === 0 ? (
        <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
          No tool data
        </div>
      ) : (
        <HBar data={items} maxItems={10} valueFormatter={(v) => v.toLocaleString()} />
      )}
    </Card>
  );
}
