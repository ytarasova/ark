import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { Server } from "lucide-react";

const btnClass = "px-3 py-1 text-xs font-medium rounded-md border border-white/[0.06] text-white/50 hover:text-white/80 hover:border-white/[0.1] transition-colors";
const btnDanger = "px-3 py-1 text-xs font-medium rounded-md border border-red-500/20 text-red-400/70 hover:text-red-400 hover:border-red-500/30 transition-colors";
const btnPrimary = "px-3 py-1 text-xs font-medium rounded-md bg-indigo-500 border border-indigo-500/50 text-white hover:bg-indigo-400 transition-colors";

function statusDotColor(status: string): string {
  switch (status) {
    case "running": return "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]";
    case "stopped": return "bg-red-400";
    case "pending": case "provisioning": return "bg-amber-400";
    default: return "bg-white/20";
  }
}

function ComputeActions({ compute, onAction }: { compute: any; onAction: (action: string) => void }) {
  const s = compute.status || "unknown";
  return (
    <div className="flex gap-1.5 flex-wrap">
      {(s === "stopped" || s === "created" || s === "destroyed") && (
        <button className={btnPrimary} onClick={() => onAction("provision")}>Provision</button>
      )}
      {(s === "stopped" || s === "created") && (
        <button className={btnClass} onClick={() => onAction("start")}>Start</button>
      )}
      {s === "running" && (
        <button className={btnDanger} onClick={() => onAction("stop")}>Stop</button>
      )}
      {s === "running" && (
        <button className={btnDanger} onClick={() => onAction("destroy")}>Destroy</button>
      )}
      {s !== "provisioning" && (
        <button className={btnDanger} onClick={() => onAction("delete")}>Delete</button>
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
          <Server size={28} className="text-white/15 mx-auto mb-3" />
          <p className="text-sm text-white/35">No compute targets</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[260px_1fr] rounded-lg border border-white/[0.06] overflow-hidden h-[calc(100vh-112px)]">
      {/* Left: list panel */}
      <div className="bg-white/[0.02] border-r border-white/[0.06] overflow-y-auto">
        {computes.map((c: any) => (
          <div
            key={c.name || c.id}
            className={cn(
              "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-white/[0.03] transition-colors text-[13px]",
              "hover:bg-white/[0.03]",
              selected === c && "bg-white/[0.05] border-l-2 border-l-indigo-400 font-semibold"
            )}
            onClick={() => setSelected(c)}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", statusDotColor(c.status || "unknown"))} />
              <span className="text-white/80 truncate">{c.name || c.id}</span>
            </div>
            <span className="text-[10px] font-mono uppercase text-white/25 tracking-wider shrink-0 ml-2">{c.provider || c.type || "local"}</span>
          </div>
        ))}
      </div>
      {/* Right: detail panel */}
      <div className="p-5 overflow-y-auto bg-[#0d0d11]">
        {selected ? (
          <>
            <h2 className="text-lg font-semibold text-white/90 mb-1">{selected.name || selected.id}</h2>
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
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">Details</h3>
              <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                <span className="text-white/35">Provider</span>
                <span className="text-white/75 font-mono">{selected.provider || selected.type || "-"}</span>
                <span className="text-white/35">Status</span>
                <span className="text-white/75 flex items-center gap-2">
                  <span className={cn("inline-block w-2 h-2 rounded-full", statusDotColor(selected.status || "unknown"))} />
                  {selected.status || "unknown"}
                </span>
                {selected.ip && (
                  <>
                    <span className="text-white/35">IP</span>
                    <span className="text-white/75 font-mono">{selected.ip}</span>
                  </>
                )}
                {selected.instanceType && (
                  <>
                    <span className="text-white/35">Instance</span>
                    <span className="text-white/75">{selected.instanceType}</span>
                  </>
                )}
                {selected.region && (
                  <>
                    <span className="text-white/35">Region</span>
                    <span className="text-white/75">{selected.region}</span>
                  </>
                )}
                {selected.created_at && (
                  <>
                    <span className="text-white/35">Created</span>
                    <span className="text-white/75">{new Date(selected.created_at).toLocaleString()}</span>
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-white/25">
            Select a compute target
          </div>
        )}
      </div>
    </div>
  );
}
