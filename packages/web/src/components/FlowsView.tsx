import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";

const GATE_CLASSES: Record<string, string> = {
  auto: "bg-success-dim text-success",
  manual: "bg-warning-dim text-warning",
  condition: "bg-tint-dim text-tint",
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
      <div className="text-center py-16 px-6 text-label-tertiary">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-15 mb-4 mx-auto">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
        <div className="text-[13px] text-label-tertiary">No flows found</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[260px_1fr] rounded-xl glass-card glass-shine-subtle overflow-hidden h-[calc(100vh-112px)] max-md:grid-cols-1">
      <div className="glass-surface bg-glass-dark border-r border-white/8 overflow-y-auto h-full">
        {flows.map((f: any) => {
          const stageCount = f.stages?.length ?? 0;
          return (
            <div
              key={f.name}
              className={cn(
                "flex justify-between items-center px-3.5 py-2.5 cursor-pointer border-b border-white/4 hover:bg-white/5 transition-colors text-xs",
                selected?.name === f.name && "bg-white/12 border-l-3 border-l-tint font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
              )}
              onClick={() => setSelected(f)}
            >
              <div className="font-medium text-[13px] text-label">{f.name}</div>
              <span className="text-[10px] font-medium uppercase tracking-[0.03em] px-2 py-0.5 rounded-full bg-white/6 text-label-tertiary whitespace-nowrap font-mono backdrop-blur-[4px]">{stageCount} stage{stageCount !== 1 ? "s" : ""}</span>
            </div>
          );
        })}
      </div>
      <div className="p-5 overflow-y-auto h-full bg-surface-0 bg-black/20 backdrop-blur-[20px] saturate-150">
        {selected ? (
          <>
            <h2 className="text-[15px] font-semibold text-label mb-1.5 tracking-[-0.01em]">{selected.name}</h2>
            {selected.description && (
              <p className="text-label-secondary text-[13px] mb-4 leading-relaxed">{selected.description}</p>
            )}
            {selected.stages && selected.stages.length > 0 && (
              <div className="mb-5">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Stages</div>
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]">#</th>
                      <th className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]">Name</th>
                      <th className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]">Agent</th>
                      <th className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-label-quaternary p-2 px-3.5 border-b border-white/8 bg-surface-0 backdrop-blur-[10px]">Gate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.stages.map((s: any, i: number) => (
                      <tr key={i} className="hover:bg-white/3 transition-colors">
                        <td className="p-2.5 px-3.5 text-xs border-b border-white/4 text-label-quaternary font-mono text-[11px]">{i + 1}</td>
                        <td className="p-2.5 px-3.5 text-xs border-b border-white/4 text-label-secondary font-semibold">{s.name}</td>
                        <td className="p-2.5 px-3.5 text-xs border-b border-white/4 text-label-secondary">{s.agent || "-"}</td>
                        <td className="p-2.5 px-3.5 text-xs border-b border-white/4">
                          <span className={cn(
                            "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-[0.03em] font-mono backdrop-blur-[4px] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
                            GATE_CLASSES[s.gate || "auto"] || GATE_CLASSES.auto
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
          <div className="text-center py-16 px-6 text-label-tertiary"><div className="text-[13px]">Select a flow</div></div>
        )}
      </div>
    </div>
  );
}
