import { Card } from "../ui/card.js";
import { HBar } from "./HBar.js";

interface McpServersPanelProps {
  data: Array<{ tool: string; calls: number }>;
  hasData?: boolean;
}

export function McpServersPanel({ data, hasData }: McpServersPanelProps) {
  const items = data.slice(0, 10).map(m => ({
    name: m.tool,
    value: m.calls,
  }));

  return (
    <Card className="p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-pink-400 mb-3">
        MCP Servers
      </h3>
      {hasData === false ? (
        <div className="text-sm text-muted-foreground text-center py-6">
          MCP data not available for some runtimes
        </div>
      ) : items.length === 0 ? (
        <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
          No MCP data
        </div>
      ) : (
        <HBar data={items} maxItems={10} valueFormatter={(v) => v.toLocaleString()} />
      )}
    </Card>
  );
}
