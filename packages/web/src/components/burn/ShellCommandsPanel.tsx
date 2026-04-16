import { Card } from "../ui/card.js";
import { HBar } from "./HBar.js";

interface ShellCommandsPanelProps {
  data: Array<{ cmd: string; calls: number }>;
  hasData?: boolean;
}

export function ShellCommandsPanel({ data, hasData }: ShellCommandsPanelProps) {
  const items = data.slice(0, 10).map(s => ({
    name: s.cmd,
    value: s.calls,
  }));

  return (
    <Card className="p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-orange-300 mb-3">
        Shell Commands
      </h3>
      {hasData === false ? (
        <div className="text-sm text-muted-foreground text-center py-6">
          Shell command data not available for some runtimes
        </div>
      ) : items.length === 0 ? (
        <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
          No shell data
        </div>
      ) : (
        <HBar data={items} maxItems={10} valueFormatter={(v) => v.toLocaleString()} />
      )}
    </Card>
  );
}
