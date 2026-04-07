import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";

const btnBase = "glass-btn inline-flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium cursor-pointer text-label active:scale-[0.97] transition-all duration-200 whitespace-nowrap";
const btnSm = "px-2.5 py-1";
const btnPrimary = "bg-tint border-none text-white font-semibold shadow-[0_2px_12px_rgba(124,106,239,0.3),inset_0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110";
const btnDanger = "text-danger border-danger/20 bg-transparent hover:bg-danger-dim hover:border-danger/30";
const btnSuccess = "text-success border-success/20 bg-transparent hover:bg-success-dim hover:border-success/30";
const btnWarning = "text-warning border-warning/20 bg-transparent hover:bg-warning-dim hover:border-warning/30";

function ComputeActions({ compute, onAction }: { compute: any; onAction: (action: string) => void }) {
  const s = compute.status || "unknown";
  return (
    <div className="flex gap-1.5 flex-wrap">
      {(s === "stopped" || s === "created" || s === "destroyed") && (
        <button className={cn(btnBase, btnSm, btnPrimary)} onClick={() => onAction("provision")}>Provision</button>
      )}
      {(s === "stopped" || s === "created") && (
        <button className={cn(btnBase, btnSm, btnSuccess)} onClick={() => onAction("start")}>Start</button>
      )}
      {s === "running" && (
        <button className={cn(btnBase, btnSm, btnWarning)} onClick={() => onAction("stop")}>Stop</button>
      )}
      {s === "running" && (
        <button className={cn(btnBase, btnSm, btnDanger)} onClick={() => onAction("destroy")}>Destroy</button>
      )}
      {s !== "provisioning" && (
        <button className={cn(btnBase, btnSm, btnDanger)} onClick={() => onAction("delete")}>Delete</button>
      )}
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "running": return "bg-success";
    case "stopped": return "bg-danger";
    case "pending": case "provisioning": return "bg-warning";
    default: return "bg-label-quaternary";
  }
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
      <div className="text-center py-16 px-6 text-label-tertiary">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-15 mb-4 mx-auto">
          <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/>
        </svg>
        <div className="text-[13px] text-label-tertiary">No compute targets</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[260px_1fr] rounded-xl glass-card glass-shine-subtle overflow-hidden h-[calc(100vh-112px)] max-md:grid-cols-1">
      <div className="glass-surface bg-glass-dark border-r border-white/8 overflow-y-auto h-full">
        {computes.map((c: any) => (
          <div
            key={c.name || c.id}
            className={cn(
              "flex justify-between items-center px-3.5 py-2.5 cursor-pointer border-b border-white/4 hover:bg-white/5 transition-colors text-xs",
              selected === c && "bg-white/12 border-l-3 border-l-tint font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            )}
            onClick={() => setSelected(c)}
          >
            <div className="flex items-center gap-2">
              <span className={cn("inline-block w-2 h-2 rounded-full", statusColor(c.status || "unknown"))} />
              <div className="font-medium text-[13px] text-label">{c.name || c.id}</div>
            </div>
            <span className="text-[10px] font-medium uppercase tracking-[0.03em] px-2 py-0.5 rounded-full bg-white/6 text-label-tertiary whitespace-nowrap font-mono backdrop-blur-[4px]">{c.provider || c.type || "local"}</span>
          </div>
        ))}
      </div>
      <div className="p-5 overflow-y-auto h-full bg-surface-0 bg-black/20 backdrop-blur-[20px] saturate-150">
        {selected ? (
          <>
            <h2 className="text-[15px] font-semibold text-label mb-1.5 tracking-[-0.01em]">{selected.name || selected.id}</h2>
            {/* Actions */}
            <div className="mb-5">
              <ComputeActions compute={selected} onAction={handleAction} />
              {actionMsg && (
                <div className={cn("mt-1.5 text-xs", actionMsg.type === "error" ? "text-danger" : "text-success")}>
                  {actionMsg.text}
                </div>
              )}
            </div>
            <div className="mb-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Details</div>
              <div className="grid grid-cols-[100px_1fr] gap-x-3.5 gap-y-1.5 text-xs">
                <div className="text-label-tertiary font-medium">Provider</div>
                <div className="text-label">{selected.provider || selected.type || "-"}</div>
                <div className="text-label-tertiary font-medium">Status</div>
                <div className="text-label flex items-center gap-2">
                  <span className={cn("inline-block w-2 h-2 rounded-full", statusColor(selected.status || "unknown"))} />
                  {selected.status || "unknown"}
                </div>
                {selected.ip && (
                  <>
                    <div className="text-label-tertiary font-medium">IP</div>
                    <div className="text-label font-mono">{selected.ip}</div>
                  </>
                )}
                {selected.instanceType && (
                  <>
                    <div className="text-label-tertiary font-medium">Instance</div>
                    <div className="text-label">{selected.instanceType}</div>
                  </>
                )}
                {selected.region && (
                  <>
                    <div className="text-label-tertiary font-medium">Region</div>
                    <div className="text-label">{selected.region}</div>
                  </>
                )}
                {selected.created_at && (
                  <>
                    <div className="text-label-tertiary font-medium">Created</div>
                    <div className="text-label">{new Date(selected.created_at).toLocaleString()}</div>
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-16 px-6 text-label-tertiary"><div className="text-[13px]">Select a compute target</div></div>
        )}
      </div>
    </div>
  );
}
