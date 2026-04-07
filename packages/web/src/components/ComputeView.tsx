import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";
import { Badge } from "./ui/badge.js";
import { Server } from "lucide-react";

function statusDotColor(status: string): string {
  switch (status) {
    case "running": return "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]";
    case "stopped": return "bg-red-400";
    case "pending": case "provisioning": return "bg-amber-400";
    default: return "bg-muted-foreground/30";
  }
}

function ComputeActions({ compute, onAction }: { compute: any; onAction: (action: string) => void }) {
  const s = compute.status || "unknown";
  return (
    <div className="flex gap-1.5 flex-wrap">
      {(s === "stopped" || s === "created" || s === "destroyed") && (
        <Button size="xs" onClick={() => onAction("provision")}>Provision</Button>
      )}
      {(s === "stopped" || s === "created") && (
        <Button variant="outline" size="xs" onClick={() => onAction("start")}>Start</Button>
      )}
      {s === "running" && (
        <Button variant="destructive" size="xs" onClick={() => onAction("stop")}>Stop</Button>
      )}
      {s === "running" && (
        <Button variant="destructive" size="xs" onClick={() => onAction("destroy")}>Destroy</Button>
      )}
      {s !== "provisioning" && (
        <Button variant="destructive" size="xs" onClick={() => onAction("delete")}>Delete</Button>
      )}
    </div>
  );
}

export function ComputeView() {
  const [computes, setComputes] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [actionMsg, setActionMsg] = useState<{ text: string; type: string } | null>(null);

  function refresh() {
    api.getCompute().then((data) => {
      setComputes(data || []);
      if (selected) {
        const updated = (data || []).find((c: any) => (c.name || c.id) === (selected.name || selected.id));
        setSelected(updated || null);
      }
    });
  }

  useEffect(() => {
    api.getCompute().then((data) => {
      setComputes(data || []);
      if (data?.length) setSelected(data[0]);
    });
  }, []);

  async function handleAction(action: string) {
    if (!selected) return;
    const name = selected.name || selected.id;
    let res: any;
    try {
      switch (action) {
        case "provision": res = await api.provisionCompute(name); break;
        case "start": res = await api.startCompute(name); break;
        case "stop": res = await api.stopCompute(name); break;
        case "destroy": res = await api.destroyCompute(name); break;
        case "delete": res = await api.deleteCompute(name); break;
        default: return;
      }
      if (res.ok !== false) {
        setActionMsg({ text: `${action} successful`, type: "success" });
        refresh();
      } else {
        setActionMsg({ text: res.message || "Action failed", type: "error" });
      }
    } catch (err: any) {
      setActionMsg({ text: err.message || "Action failed", type: "error" });
    }
    setTimeout(() => setActionMsg(null), 3000);
  }

  if (!computes.length) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <Server size={28} className="text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No compute targets</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
      {/* Left: list panel */}
      <div className="bg-card border-r border-border overflow-y-auto">
        {computes.map((c: any) => (
          <div
            key={c.name || c.id}
            className={cn(
              "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
              "hover:bg-accent",
              selected === c && "bg-accent border-l-2 border-l-primary font-semibold"
            )}
            onClick={() => setSelected(c)}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", statusDotColor(c.status || "unknown"))} />
              <span className="text-foreground truncate">{c.name || c.id}</span>
            </div>
            <Badge variant="secondary" className="text-[10px] shrink-0 ml-2">{c.provider || c.type || "local"}</Badge>
          </div>
        ))}
      </div>
      {/* Right: detail panel */}
      <div className="p-5 overflow-y-auto bg-background">
        {selected ? (
          <>
            <h2 className="text-lg font-semibold text-foreground mb-1">{selected.name || selected.id}</h2>
            {/* Actions */}
            <div className="mb-5">
              <ComputeActions compute={selected} onAction={handleAction} />
              {actionMsg && (
                <div className={cn("mt-1.5 text-xs", actionMsg.type === "error" ? "text-red-400" : "text-emerald-400")}>
                  {actionMsg.text}
                </div>
              )}
            </div>
            <div className="mb-4">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Details</h3>
              <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                <span className="text-muted-foreground">Provider</span>
                <span className="text-card-foreground font-mono">{selected.provider || selected.type || "-"}</span>
                <span className="text-muted-foreground">Status</span>
                <span className="text-card-foreground flex items-center gap-2">
                  <span className={cn("inline-block w-2 h-2 rounded-full", statusDotColor(selected.status || "unknown"))} />
                  {selected.status || "unknown"}
                </span>
                {selected.ip && (
                  <>
                    <span className="text-muted-foreground">IP</span>
                    <span className="text-card-foreground font-mono">{selected.ip}</span>
                  </>
                )}
                {selected.instanceType && (
                  <>
                    <span className="text-muted-foreground">Instance</span>
                    <span className="text-card-foreground">{selected.instanceType}</span>
                  </>
                )}
                {selected.region && (
                  <>
                    <span className="text-muted-foreground">Region</span>
                    <span className="text-card-foreground">{selected.region}</span>
                  </>
                )}
                {selected.created_at && (
                  <>
                    <span className="text-muted-foreground">Created</span>
                    <span className="text-card-foreground">{new Date(selected.created_at).toLocaleString()}</span>
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select a compute target
          </div>
        )}
      </div>
    </div>
  );
}
