import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { Card } from "./ui/card.js";
import { Badge } from "./ui/badge.js";
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
          <Settings size={28} className="text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No agents found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
      {/* Left: list panel */}
      <div className="bg-card border-r border-border overflow-y-auto">
        {agents.map((a: any) => (
          <div
            key={a.name}
            className={cn(
              "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
              "hover:bg-accent",
              selected?.name === a.name && "bg-accent border-l-2 border-l-primary font-semibold"
            )}
            onClick={() => setSelected(a)}
          >
            <span className="text-foreground truncate">{a.name}</span>
            <Badge variant="secondary" className="text-[10px]">{a.source || "builtin"}</Badge>
          </div>
        ))}
      </div>
      {/* Right: detail panel */}
      <div className="p-5 overflow-y-auto bg-background">
        {selected ? (
          <>
            <h2 className="text-lg font-semibold text-foreground mb-1">{selected.name}</h2>
            {selected.description && (
              <p className="text-sm text-muted-foreground mb-5">{selected.description}</p>
            )}
            <div className="mb-4">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Configuration</h3>
              <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                <span className="text-muted-foreground">Model</span>
                <span className="text-card-foreground font-mono">{selected.model || "-"}</span>
                <span className="text-muted-foreground">Max Turns</span>
                <span className="text-card-foreground font-mono">{selected.max_turns ?? "-"}</span>
                <span className="text-muted-foreground">Permission</span>
                <span className="text-card-foreground font-mono">{selected.permission_mode || "-"}</span>
                <span className="text-muted-foreground">Runtime</span>
                <span className="text-card-foreground font-mono">{selected.runtime || "claude-code"}</span>
              </div>
            </div>
            {selected.skills && selected.skills.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Skills</h3>
                <div className="flex flex-wrap gap-1.5">
                  {selected.skills.map((s: string) => (
                    <Badge key={s} variant="default" className="text-[11px]">{s}</Badge>
                  ))}
                </div>
              </div>
            )}
            {selected.tools && selected.tools.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Tools</h3>
                <div className="flex flex-wrap gap-1.5">
                  {selected.tools.map((t: string) => (
                    <Badge key={t} variant="secondary" className="text-[11px]">{t}</Badge>
                  ))}
                </div>
              </div>
            )}
            {selected.mcp_servers && selected.mcp_servers.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">MCP Servers</h3>
                <div className="flex flex-wrap gap-1.5">
                  {selected.mcp_servers.map((m: string) => (
                    <Badge key={m} variant="secondary" className="text-[11px]">{m}</Badge>
                  ))}
                </div>
              </div>
            )}
            {selected.system_prompt && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">System Prompt</h3>
                <div className="bg-black/40 border border-border rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-muted-foreground">{selected.system_prompt}</div>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select an agent
          </div>
        )}
      </div>
    </div>
  );
}
