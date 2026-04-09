import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useComputeQuery } from "../hooks/useComputeQueries.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Badge } from "./ui/badge.js";
import { Server } from "lucide-react";
import { selectClassName } from "./ui/styles.js";

function NewComputeForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (form: any) => void }) {
  const [form, setForm] = useState({ name: "", provider: "local", size: "", region: "", aws_profile: "", vpc_id: "", subnet_id: "" });

  function update(key: string, val: string) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSubmit(form);
  }

  return (
    <div className="flex flex-col h-full p-5 overflow-y-auto">
      <h2 className="text-base font-semibold text-foreground mb-5">New Compute Target</h2>
      <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Name *</label>
          <Input autoFocus value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="my-compute" />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Provider</label>
          <select className={selectClassName} value={form.provider} onChange={(e) => update("provider", e.target.value)}>
            <option value="local">local</option>
            <option value="docker">docker</option>
            <option value="devcontainer">devcontainer</option>
            <option value="ec2">ec2</option>
            <option value="ec2-docker">ec2-docker</option>
            <option value="ec2-devcontainer">ec2-devcontainer</option>
          </select>
        </div>
        {(form.provider.startsWith("ec2")) && (
          <>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Size</label>
              <select className={selectClassName} value={form.size} onChange={(e) => update("size", e.target.value)}>
                <option value="">Default</option>
                <option value="xs">XS (2 vCPU, 8 GB)</option>
                <option value="s">S (4 vCPU, 16 GB)</option>
                <option value="m">M (8 vCPU, 32 GB)</option>
                <option value="l">L (16 vCPU, 64 GB)</option>
                <option value="xl">XL (32 vCPU, 128 GB)</option>
              </select>
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Region</label>
              <Input value={form.region} onChange={(e) => update("region", e.target.value)} placeholder="us-east-1" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">AWS Profile</label>
              <Input value={form.aws_profile} onChange={(e) => update("aws_profile", e.target.value)} placeholder="default" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">VPC ID</label>
              <Input value={form.vpc_id} onChange={(e) => update("vpc_id", e.target.value)} placeholder="vpc-xxxxxxxx (optional)" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Subnet ID</label>
              <Input value={form.subnet_id} onChange={(e) => update("subnet_id", e.target.value)} placeholder="subnet-xxxxxxxx (optional)" />
            </div>
          </>
        )}
        <div className="flex gap-2 pt-4 border-t border-border mt-auto">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm">Create Compute</Button>
        </div>
      </form>
    </div>
  );
}

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

interface ComputeViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
}

export function ComputeView({ showCreate = false, onCloseCreate }: ComputeViewProps) {
  const queryClient = useQueryClient();
  const { data: computes = [] } = useComputeQuery();
  const [selected, setSelected] = useState<any>(null);
  const [actionMsg, setActionMsg] = useState<{ text: string; type: string } | null>(null);

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
        queryClient.invalidateQueries({ queryKey: ["compute"] });
      } else {
        setActionMsg({ text: res.message || "Action failed", type: "error" });
      }
    } catch (err: any) {
      setActionMsg({ text: err.message || "Action failed", type: "error" });
    }
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function handleCreate(form: any) {
    try {
      const config: any = {};
      if (form.size) config.size = form.size;
      if (form.region) config.region = form.region;
      await api.createCompute({ name: form.name, provider: form.provider, config });
      onCloseCreate?.();
      queryClient.invalidateQueries({ queryKey: ["compute"] });
    } catch (err: any) {
      setActionMsg({ text: err.message || "Failed to create compute", type: "error" });
      setTimeout(() => setActionMsg(null), 3000);
    }
  }

  if (!computes.length && !showCreate) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <Server size={28} className="text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No compute targets</p>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
      {/* Left: list panel */}
      <div className="border-r border-border overflow-y-auto">
        {computes.map((c: any) => (
          <div
            key={c.name || c.id}
            className={cn(
              "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
              "hover:bg-accent",
              (selected?.name || selected?.id) === (c.name || c.id) && "bg-accent border-l-2 border-l-primary font-semibold"
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
      {/* Right: detail panel or create form */}
      <div className="overflow-y-auto bg-background">
        {showCreate ? (
          <NewComputeForm onClose={() => onCloseCreate?.()} onSubmit={handleCreate} />
        ) : selected ? (
          <div className="p-5">
            <h2 className="text-lg font-semibold text-foreground mb-1">{selected.name || selected.id}</h2>
            {/* Actions - hide for local provider */}
            {selected.provider !== "local" && (
              <div className="mb-5">
                <ComputeActions compute={selected} onAction={handleAction} />
                {actionMsg && (
                  <div className={cn("mt-1.5 text-xs", actionMsg.type === "error" ? "text-red-400" : "text-emerald-400")}>
                    {actionMsg.text}
                  </div>
                )}
              </div>
            )}
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
                {selected.config?.ip && (
                  <>
                    <span className="text-muted-foreground">IP</span>
                    <span className="text-card-foreground font-mono">{selected.config.ip}</span>
                  </>
                )}
                {selected.config?.instanceType && (
                  <>
                    <span className="text-muted-foreground">Instance</span>
                    <span className="text-card-foreground font-mono">{selected.config.instanceType}</span>
                  </>
                )}
                {selected.config?.region && (
                  <>
                    <span className="text-muted-foreground">Region</span>
                    <span className="text-card-foreground font-mono">{selected.config.region}</span>
                  </>
                )}
                {selected.config?.publicIp && !selected.config?.ip && (
                  <>
                    <span className="text-muted-foreground">Public IP</span>
                    <span className="text-card-foreground font-mono">{selected.config.publicIp}</span>
                  </>
                )}
                {selected.config?.hourlyRate != null && (
                  <>
                    <span className="text-muted-foreground">Hourly Rate</span>
                    <span className="text-card-foreground font-mono">${selected.config.hourlyRate}/hr</span>
                  </>
                )}
                {selected.config?.runningSessions != null && (
                  <>
                    <span className="text-muted-foreground">Running Sessions</span>
                    <span className="text-card-foreground font-mono">{selected.config.runningSessions}</span>
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
            {/* Metrics - show if available */}
            {selected.config?.metrics && (
              <div className="mt-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Metrics</h3>
                <div className="grid grid-cols-3 gap-3">
                  {selected.config.metrics.cpu != null && (
                    <div className="bg-secondary rounded-md p-3">
                      <div className="text-xs text-muted-foreground mb-1">CPU</div>
                      <div className="text-lg font-mono font-semibold text-foreground">{selected.config.metrics.cpu}%</div>
                    </div>
                  )}
                  {selected.config.metrics.memPct != null && (
                    <div className="bg-secondary rounded-md p-3">
                      <div className="text-xs text-muted-foreground mb-1">Memory</div>
                      <div className="text-lg font-mono font-semibold text-foreground">{selected.config.metrics.memPct}%</div>
                    </div>
                  )}
                  {selected.config.metrics.diskPct != null && (
                    <div className="bg-secondary rounded-md p-3">
                      <div className="text-xs text-muted-foreground mb-1">Disk</div>
                      <div className="text-lg font-mono font-semibold text-foreground">{selected.config.metrics.diskPct}%</div>
                    </div>
                  )}
                  {selected.config.metrics.netRx != null && (
                    <div className="bg-secondary rounded-md p-3">
                      <div className="text-xs text-muted-foreground mb-1">Network RX</div>
                      <div className="text-lg font-mono font-semibold text-foreground">{selected.config.metrics.netRx}</div>
                    </div>
                  )}
                  {selected.config.metrics.netTx != null && (
                    <div className="bg-secondary rounded-md p-3">
                      <div className="text-xs text-muted-foreground mb-1">Network TX</div>
                      <div className="text-lg font-mono font-semibold text-foreground">{selected.config.metrics.netTx}</div>
                    </div>
                  )}
                  {selected.config.metrics.uptime != null && (
                    <div className="bg-secondary rounded-md p-3">
                      <div className="text-xs text-muted-foreground mb-1">Uptime</div>
                      <div className="text-lg font-mono font-semibold text-foreground">{selected.config.metrics.uptime}</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select a compute target
          </div>
        )}
      </div>
    </div>
    </>
  );
}
