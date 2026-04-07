import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { Card } from "./ui/card.js";
import { Badge } from "./ui/badge.js";
import { GitBranch } from "lucide-react";

const GATE_VARIANT: Record<string, "success" | "warning" | "info" | "default"> = {
  auto: "success",
  manual: "warning",
  condition: "info",
  review: "default",
};

export function FlowsView() {
  const [flows, setFlows] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    api.getFlows().then((data) => {
      setFlows(data || []);
      if (data?.length) selectFlow(data[0]);
    });
  }, []);

  function selectFlow(flow: any) {
    // Fetch detail to get full stage objects (list endpoint only has stage names as strings)
    api.getFlowDetail(flow.name).then((detail) => {
      setSelected(detail || flow);
    }).catch(() => {
      setSelected(flow);
    });
  }

  if (!flows.length) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <GitBranch size={28} className="text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No flows found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
      {/* Left: list panel */}
      <div className="bg-card border-r border-border overflow-y-auto">
        {flows.map((f: any) => {
          const stageCount = f.stages?.length ?? 0;
          return (
            <div
              key={f.name}
              className={cn(
                "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                "hover:bg-accent",
                selected?.name === f.name && "bg-accent border-l-2 border-l-primary font-semibold"
              )}
              onClick={() => selectFlow(f)}
            >
              <span className="text-foreground truncate">{f.name}</span>
              <Badge variant="secondary" className="text-[10px]">{stageCount} stage{stageCount !== 1 ? "s" : ""}</Badge>
            </div>
          );
        })}
      </div>
      {/* Right: detail panel */}
      <div className="p-5 overflow-y-auto bg-background">
        {selected ? (
          <>
            <h2 className="text-lg font-semibold text-foreground mb-1">{selected.name}</h2>
            {selected.description && (
              <p className="text-sm text-muted-foreground mb-5">{selected.description}</p>
            )}
            {selected.stages && selected.stages.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Stages</h3>
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border">#</th>
                      <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border">Name</th>
                      <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border">Agent</th>
                      <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border">Gate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.stages.map((s: any, i: number) => {
                      // Handle both object stages (from detail endpoint) and string stages (from list endpoint)
                      const stageName = typeof s === "string" ? s : s.name;
                      const agent = typeof s === "string" ? "-" : (s.agent || "-");
                      const gate = typeof s === "string" ? "auto" : (s.gate || "auto");
                      return (
                        <tr key={i} className="hover:bg-accent transition-colors">
                          <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-muted-foreground font-mono text-[11px]">{i + 1}</td>
                          <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-foreground font-semibold">{stageName || "-"}</td>
                          <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground">{agent}</td>
                          <td className="p-2.5 px-3 text-[13px] border-b border-border/50">
                            <Badge variant={GATE_VARIANT[gate] || "success"} className="text-[10px]">
                              {gate}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select a flow
          </div>
        )}
      </div>
    </div>
  );
}
