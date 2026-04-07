import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { GitBranch } from "lucide-react";

const GATE_COLORS: Record<string, string> = {
  auto: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  manual: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  condition: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  review: "bg-purple-500/10 text-purple-400 border-purple-500/20",
};

export function FlowsView() {
  const [flows, setFlows] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    api.getFlows().then((data) => {
      setFlows(data || []);
      if (data?.length) setSelected(data[0]);
    });
  }, []);

  if (!flows.length) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <GitBranch size={28} className="text-white/15 mx-auto mb-3" />
          <p className="text-sm text-white/35">No flows found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[260px_1fr] rounded-lg border border-white/[0.06] overflow-hidden h-[calc(100vh-112px)]">
      {/* Left: list panel */}
      <div className="bg-white/[0.02] border-r border-white/[0.06] overflow-y-auto">
        {flows.map((f: any) => {
          const stageCount = f.stages?.length ?? 0;
          return (
            <div
              key={f.name}
              className={cn(
                "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-white/[0.03] transition-colors text-[13px]",
                "hover:bg-white/[0.03]",
                selected?.name === f.name && "bg-white/[0.05] border-l-2 border-l-indigo-400 font-semibold"
              )}
              onClick={() => setSelected(f)}
            >
              <span className="text-white/80 truncate">{f.name}</span>
              <span className="text-[10px] font-mono uppercase text-white/25 tracking-wider">{stageCount} stage{stageCount !== 1 ? "s" : ""}</span>
            </div>
          );
        })}
      </div>
      {/* Right: detail panel */}
      <div className="p-5 overflow-y-auto bg-[#0d0d11]">
        {selected ? (
          <>
            <h2 className="text-lg font-semibold text-white/90 mb-1">{selected.name}</h2>
            {selected.description && (
              <p className="text-sm text-white/40 mb-5">{selected.description}</p>
            )}
            {selected.stages && selected.stages.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">Stages</h3>
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 p-2 px-3 border-b border-white/[0.06]">#</th>
                      <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 p-2 px-3 border-b border-white/[0.06]">Name</th>
                      <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 p-2 px-3 border-b border-white/[0.06]">Agent</th>
                      <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 p-2 px-3 border-b border-white/[0.06]">Gate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.stages.map((s: any, i: number) => (
                      <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                        <td className="p-2.5 px-3 text-[13px] border-b border-white/[0.03] text-white/25 font-mono text-[11px]">{i + 1}</td>
                        <td className="p-2.5 px-3 text-[13px] border-b border-white/[0.03] text-white/70 font-semibold">{s.name}</td>
                        <td className="p-2.5 px-3 text-[13px] border-b border-white/[0.03] text-white/60">{s.agent || "-"}</td>
                        <td className="p-2.5 px-3 text-[13px] border-b border-white/[0.03]">
                          <span className={cn(
                            "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-medium uppercase tracking-wider border",
                            GATE_COLORS[s.gate || "auto"] || GATE_COLORS.auto
                          )}>
                            {s.gate || "auto"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-white/25">
            Select a flow
          </div>
        )}
      </div>
    </div>
  );
}
