import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { Settings } from "lucide-react";

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
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <Settings size={28} className="text-white/15 mx-auto mb-3" />
          <p className="text-sm text-white/35">No agents found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[260px_1fr] rounded-lg border border-white/[0.06] overflow-hidden h-[calc(100vh-112px)]">
      {/* Left: list panel */}
      <div className="bg-white/[0.02] border-r border-white/[0.06] overflow-y-auto">
        {agents.map((a: any) => (
          <div
            key={a.name}
            className={cn(
              "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-white/[0.03] transition-colors text-[13px]",
              "hover:bg-white/[0.03]",
              selected?.name === a.name && "bg-white/[0.05] border-l-2 border-l-indigo-400 font-semibold"
            )}
            onClick={() => setSelected(a)}
          >
            <span className="text-white/80 truncate">{a.name}</span>
            <span className="text-[10px] font-mono uppercase text-white/25 tracking-wider">{a.source || "builtin"}</span>
          </div>
        ))}
      </div>
      {/* Right: detail panel */}
      <div className="p-5 overflow-y-auto bg-[#0d0d11]">
        {selected ? (
          <>
            <h2 className="text-lg font-semibold text-white/90 mb-1">{selected.name}</h2>
            {selected.description && (
              <p className="text-sm text-white/40 mb-5">{selected.description}</p>
            )}
            <div className="mb-4">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">Configuration</h3>
              <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                <span className="text-white/35">Model</span>
                <span className="text-white/75 font-mono">{selected.model || "-"}</span>
                <span className="text-white/35">Max Turns</span>
                <span className="text-white/75 font-mono">{selected.max_turns ?? "-"}</span>
                <span className="text-white/35">Permission</span>
                <span className="text-white/75 font-mono">{selected.permission_mode || "-"}</span>
                <span className="text-white/35">Runtime</span>
                <span className="text-white/75 font-mono">{selected.runtime || "claude-code"}</span>
              </div>
            </div>
            {selected.skills && selected.skills.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">Skills</h3>
                <div className="flex flex-wrap gap-1.5">
                  {selected.skills.map((s: string) => (
                    <span key={s} className="inline-block px-2 py-0.5 rounded text-[11px] font-mono bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">{s}</span>
                  ))}
                </div>
              </div>
            )}
            {selected.tools && selected.tools.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">Tools</h3>
                <div className="flex flex-wrap gap-1.5">
                  {selected.tools.map((t: string) => (
                    <span key={t} className="inline-block px-2 py-0.5 rounded text-[11px] font-mono bg-white/[0.04] border border-white/[0.06] text-white/60">{t}</span>
                  ))}
                </div>
              </div>
            )}
            {selected.mcp_servers && selected.mcp_servers.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">MCP Servers</h3>
                <div className="flex flex-wrap gap-1.5">
                  {selected.mcp_servers.map((m: string) => (
                    <span key={m} className="inline-block px-2 py-0.5 rounded text-[11px] font-mono bg-white/[0.04] border border-white/[0.06] text-white/60">{m}</span>
                  ))}
                </div>
              </div>
            )}
            {selected.system_prompt && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">System Prompt</h3>
                <div className="bg-black/40 border border-white/[0.06] rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-white/50">{selected.system_prompt}</div>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-white/25">
            Select an agent
          </div>
        )}
      </div>
    </div>
  );
}
