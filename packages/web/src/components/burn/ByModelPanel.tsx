import { Card } from "../ui/card.js";
import { fmtCost } from "../../util.js";
import { HBar } from "./HBar.js";

interface ModelEntry {
  model: string;
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface ByModelPanelProps {
  data: ModelEntry[];
}

export function ByModelPanel({ data }: ByModelPanelProps) {
  const items = data.map(m => ({
    name: m.model,
    value: m.cost,
  }));

  return (
    <Card className="p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fuchsia-400 mb-3">
        By Model
      </h3>
      {items.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
          No model data
        </div>
      ) : (
        <HBar data={items} valueFormatter={fmtCost} />
      )}
    </Card>
  );
}
