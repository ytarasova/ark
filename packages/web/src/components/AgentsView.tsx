import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";

export function AgentsView() {
  const [agents, setAgents] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    api.getAgents().then((data) => {
      setAgents(data || []);
      if (data?.length) setSelected(data[0]);
    });
  }, []);

  if (!agents.length) {
    return (
      <div className="text-center py-16 px-6 text-label-tertiary">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-15 mb-4 mx-auto">
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <div className="text-[13px] text-label-tertiary">No agents found</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[260px_1fr] rounded-xl glass-card glass-shine-subtle overflow-hidden h-[calc(100vh-112px)] max-md:grid-cols-1">
      <div className="glass-surface bg-glass-dark border-r border-white/8 overflow-y-auto h-full">
        {agents.map((a: any) => (
          <div
            key={a.name}
            className={cn(
              "flex justify-between items-center px-3.5 py-2.5 cursor-pointer border-b border-white/4 hover:bg-white/5 transition-colors text-xs",
              selected?.name === a.name && "bg-white/12 border-l-3 border-l-tint font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            )}
            onClick={() => setSelected(a)}
          >
            <div className="font-medium text-[13px] text-label">{a.name}</div>
            <span className="text-[10px] font-medium uppercase tracking-[0.03em] px-2 py-0.5 rounded-full bg-white/6 text-label-tertiary whitespace-nowrap font-mono backdrop-blur-[4px]">{a.source || "builtin"}</span>
          </div>
        ))}
      </div>
      <div className="p-5 overflow-y-auto h-full bg-surface-0 bg-black/20 backdrop-blur-[20px] saturate-150">
        {selected ? (
          <>
            <h2 className="text-[15px] font-semibold text-label mb-1.5 tracking-[-0.01em]">{selected.name}</h2>
            {selected.description && (
              <p className="text-label-secondary text-[13px] mb-4 leading-relaxed">{selected.description}</p>
            )}
            <div className="mb-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Configuration</div>
              <div className="grid grid-cols-[100px_1fr] gap-x-3.5 gap-y-1.5 text-xs">
                <div className="text-label-tertiary font-medium">Model</div>
                <div className="text-label">{selected.model || "-"}</div>
                <div className="text-label-tertiary font-medium">Max Turns</div>
                <div className="text-label">{selected.max_turns ?? "-"}</div>
                <div className="text-label-tertiary font-medium">Permission</div>
                <div className="text-label">{selected.permission_mode || "-"}</div>
              </div>
            </div>
            {selected.tools && selected.tools.length > 0 && (
              <div className="mb-5">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Tools</div>
                <div className="flex flex-wrap gap-1.5">
                  {selected.tools.map((t: string) => (
                    <span key={t} className="inline-block px-2 py-[3px] rounded-lg text-[11px] font-mono glass-surface text-label shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:border-white/15 transition-all">{t}</span>
                  ))}
                </div>
              </div>
            )}
            {selected.skills && selected.skills.length > 0 && (
              <div className="mb-5">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Skills</div>
                <div className="flex flex-wrap gap-1.5">
                  {selected.skills.map((s: string) => (
                    <span key={s} className="inline-block px-2 py-[3px] rounded-lg text-[11px] font-mono bg-tint-dim border border-tint/20 text-tint">{s}</span>
                  ))}
                </div>
              </div>
            )}
            {selected.system_prompt && (
              <div className="mb-5">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">System Prompt</div>
                <div className="bg-[rgba(8,8,12,0.8)] border border-white/8 rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-label-secondary shadow-[inset_0_2px_4px_rgba(0,0,0,0.3)]">{selected.system_prompt}</div>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-16 px-6 text-label-tertiary"><div className="text-[13px]">Select an agent</div></div>
        )}
      </div>
    </div>
  );
}
