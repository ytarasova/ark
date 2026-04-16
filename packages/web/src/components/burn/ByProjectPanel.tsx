import { Card } from "../ui/card.js";
import { fmtCost } from "../../util.js";
import { HBar } from "./HBar.js";

interface ProjectEntry {
  project: string;
  cost: number;
  sessions: number;
}

interface ByProjectPanelProps {
  data: ProjectEntry[];
}

function shortProject(encoded: string): string {
  // Strip home dir prefix, show last 3 path segments
  let path = encoded.replace(/^-/, "");
  const home = "Users";
  const homeIdx = path.indexOf(home);
  if (homeIdx >= 0) {
    // Find the part after the username
    const afterHome = path.slice(homeIdx);
    const parts = afterHome.split(/[-/\\]/).filter(Boolean);
    // Skip "Users" and the username
    const relevant = parts.slice(2);
    if (relevant.length <= 3) return relevant.join("/");
    return relevant.slice(-3).join("/");
  }
  const parts = path.split(/[-/\\]/).filter(Boolean);
  if (parts.length <= 3) return parts.join("/");
  return parts.slice(-3).join("/");
}

export function ByProjectPanel({ data }: ByProjectPanelProps) {
  const items = data.slice(0, 8).map(p => ({
    name: shortProject(p.project),
    value: p.cost,
  }));

  return (
    <Card className="p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-400 mb-3">
        By Project
      </h3>
      {items.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
          No project data
        </div>
      ) : (
        <HBar data={items} maxItems={8} valueFormatter={fmtCost} />
      )}
    </Card>
  );
}
