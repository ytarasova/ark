import { useState, useEffect, useCallback, useRef, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useComputeQuery } from "../hooks/useComputeQueries.js";
import { useSmartPoll } from "../hooks/useSmartPoll.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Badge } from "./ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";
import { Server, Cpu, HardDrive, MemoryStick, Clock, Container, Terminal, Activity } from "lucide-react";
import { selectClassName } from "./ui/styles.js";
import { AreaChart, Area, ResponsiveContainer, Tooltip } from "recharts";
import { ChartTooltip } from "./ui/chart.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface SnapshotMetrics {
  cpu: number;
  memUsedGb: number;
  memTotalGb: number;
  memPct: number;
  diskPct: number;
  netRxMb: number;
  netTxMb: number;
  uptime: string;
  idleTicks: number;
}

interface SnapshotSession {
  name: string;
  status: string;
  mode: string;
  projectPath: string;
  cpu: number;
  mem: number;
}

interface SnapshotProcess {
  pid: string;
  cpu: string;
  mem: string;
  command: string;
  workingDir: string;
}

interface DockerContainer {
  name: string;
  cpu: string;
  memory: string;
  image: string;
  project: string;
}

interface ComputeSnapshot {
  metrics: SnapshotMetrics;
  sessions: SnapshotSession[];
  processes: SnapshotProcess[];
  docker: DockerContainer[];
}

interface CpuHistoryPoint {
  t: number;
  cpu: number;
  mem: number;
}

// ── New Compute Form ────────────────────────────────────────────────────────

function NewComputeForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (form: any) => void }) {
  const [form, setForm] = useState({
    name: "",
    provider: "local",
    size: "",
    region: "",
    aws_profile: "",
    vpc_id: "",
    subnet_id: "",
  });
  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [templateConfig, setTemplateConfig] = useState<Record<string, unknown>>({});

  useEffect(() => {
    api
      .listComputeTemplates()
      .then(setTemplates)
      .catch(() => {});
  }, []);

  function update(key: string, val: string) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleTemplateChange(templateName: string) {
    setSelectedTemplate(templateName);
    if (!templateName) {
      setTemplateConfig({});
      return;
    }
    const tmpl = templates.find((t) => t.name === templateName);
    if (tmpl) {
      setForm((prev) => ({ ...prev, provider: tmpl.provider }));
      setTemplateConfig(tmpl.config ?? {});
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSubmit({ ...form, templateConfig });
  }

  return (
    <div className="flex flex-col h-full p-5 overflow-y-auto">
      <h2 className="text-base font-semibold text-foreground mb-5">New Compute Target</h2>
      <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
        {templates.length > 0 && (
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
              Template
            </label>
            <select
              className={selectClassName}
              value={selectedTemplate}
              onChange={(e) => handleTemplateChange(e.target.value)}
            >
              <option value="">(None)</option>
              {templates.map((t: any) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                  {t.description ? ` - ${t.description}` : ""} [{t.provider}]
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Name *
          </label>
          <Input
            autoFocus
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="my-compute"
          />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Provider
          </label>
          <select
            className={selectClassName}
            value={form.provider}
            onChange={(e) => update("provider", e.target.value)}
          >
            <option value="local">local</option>
            <option value="docker">docker</option>
            <option value="devcontainer">devcontainer</option>
            <option value="ec2">ec2</option>
            <option value="ec2-docker">ec2-docker</option>
            <option value="ec2-devcontainer">ec2-devcontainer</option>
          </select>
        </div>
        {form.provider.startsWith("ec2") && (
          <>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                Size
              </label>
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
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                Region
              </label>
              <Input value={form.region} onChange={(e) => update("region", e.target.value)} placeholder="us-east-1" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                AWS Profile
              </label>
              <Input
                value={form.aws_profile}
                onChange={(e) => update("aws_profile", e.target.value)}
                placeholder="default"
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                VPC ID
              </label>
              <Input
                value={form.vpc_id}
                onChange={(e) => update("vpc_id", e.target.value)}
                placeholder="vpc-xxxxxxxx (optional)"
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                Subnet ID
              </label>
              <Input
                value={form.subnet_id}
                onChange={(e) => update("subnet_id", e.target.value)}
                placeholder="subnet-xxxxxxxx (optional)"
              />
            </div>
          </>
        )}
        <div className="flex gap-2 pt-4 border-t border-border mt-auto">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm">
            Create Compute
          </Button>
        </div>
      </form>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function statusDotColor(status: string): string {
  switch (status) {
    case "running":
      return "bg-[var(--running)] shadow-[0_0_6px_rgba(52,211,153,0.5)]";
    case "stopped":
      return "bg-[var(--failed)]";
    case "pending":
    case "provisioning":
      return "bg-[var(--waiting)]";
    default:
      return "bg-muted-foreground/30";
  }
}

function pctColor(pct: number): string {
  if (pct >= 90) return "var(--failed, #f87171)";
  if (pct >= 70) return "var(--waiting, #fbbf24)";
  return "var(--running, #34d399)";
}

function pctBarClass(pct: number): string {
  if (pct >= 90) return "bg-[var(--failed)]";
  if (pct >= 70) return "bg-[var(--waiting)]";
  return "bg-[var(--running)]";
}

function isArkProcess(command: string): boolean {
  const patterns = ["claude", "codex", "gemini", "goose", "tmux", "ark", "bun", "conductor", "channel"];
  const lower = command.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

// ── Metric Bar ──────────────────────────────────────────────────────────────

function MetricBar({ value, total, unit, pct }: { value: string; total?: string; unit?: string; pct: number }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[12px]">
        <span className="font-mono text-foreground font-medium">
          {value}
          {total ? ` / ${total}` : ""}
          {unit ? ` ${unit}` : ""}
        </span>
        <span className="text-muted-foreground">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", pctBarClass(pct))}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

// ── CPU Sparkline ───────────────────────────────────────────────────────────

function CpuSparkline({ history }: { history: CpuHistoryPoint[] }) {
  if (history.length < 2) return null;
  return (
    <div className="h-[60px] w-full mt-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={history} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary, #7c6aef)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--primary, #7c6aef)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Tooltip content={<ChartTooltip formatter={(v: number) => `${v}%`} />} />
          <Area
            type="monotone"
            dataKey="cpu"
            stroke="var(--primary, #7c6aef)"
            strokeWidth={1.5}
            fill="url(#cpuGrad)"
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Compute Actions ─────────────────────────────────────────────────────────

function ComputeActions({ compute, onAction }: { compute: any; onAction: (action: string) => void }) {
  const s = compute.status || "unknown";
  return (
    <div className="flex gap-1.5 flex-wrap">
      {(s === "stopped" || s === "created" || s === "destroyed") && (
        <Button size="xs" onClick={() => onAction("provision")}>
          Provision
        </Button>
      )}
      {(s === "stopped" || s === "created") && (
        <Button variant="outline" size="xs" onClick={() => onAction("start")}>
          Start
        </Button>
      )}
      {s === "running" && (
        <Button variant="destructive" size="xs" onClick={() => onAction("stop")}>
          Stop
        </Button>
      )}
      {s === "running" && (
        <Button variant="destructive" size="xs" onClick={() => onAction("destroy")}>
          Destroy
        </Button>
      )}
      {s !== "provisioning" && (
        <Button variant="destructive" size="xs" onClick={() => onAction("delete")}>
          Delete
        </Button>
      )}
    </div>
  );
}

// ── Detail Panel ────────────────────────────────────────────────────────────

function ComputeDetailPanel({
  compute,
  snapshot,
  cpuHistory,
  sessions,
  onAction,
  actionMsg,
}: {
  compute: any;
  snapshot: ComputeSnapshot | null;
  cpuHistory: CpuHistoryPoint[];
  sessions: any[];
  onAction: (action: string) => void;
  actionMsg: { text: string; type: string } | null;
}) {
  const m = snapshot?.metrics;
  const arkProcs = (snapshot?.processes ?? []).filter((p) => isArkProcess(p.command));
  const otherProcs = (snapshot?.processes ?? []).filter((p) => !isArkProcess(p.command));
  const computeSessions = sessions.filter(
    (s) =>
      s.compute_name === (compute.name || compute.id) ||
      (!s.compute_name && (compute.provider === "local" || compute.type === "local")),
  );

  return (
    <div className="p-5 overflow-y-auto h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-semibold text-foreground">{compute.name || compute.id}</h2>
        <Badge variant="secondary" className="text-[10px]">
          {compute.provider || compute.type || "local"}
        </Badge>
        <span className="flex items-center gap-1.5 text-[12px]">
          <span className={cn("inline-block w-2 h-2 rounded-full", statusDotColor(compute.status || "unknown"))} />
          <span className="text-muted-foreground">{compute.status || "unknown"}</span>
        </span>
      </div>

      {/* Actions - hide for local provider */}
      {compute.provider !== "local" && (
        <div className="mb-5">
          <ComputeActions compute={compute} onAction={onAction} />
          {actionMsg && (
            <div
              className={cn(
                "mt-1.5 text-xs",
                actionMsg.type === "error" ? "text-[var(--failed)]" : "text-[var(--running)]",
              )}
            >
              {actionMsg.text}
            </div>
          )}
        </div>
      )}

      {/* System Metrics Cards */}
      {m ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          {/* CPU */}
          <Card>
            <CardHeader className="pb-1 pt-3 px-3">
              <CardTitle className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex items-center gap-1.5">
                <Cpu size={12} className="opacity-50" />
                CPU
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div className="text-2xl font-mono font-bold" style={{ color: pctColor(m.cpu) }}>
                {m.cpu}%
              </div>
              <CpuSparkline history={cpuHistory} />
            </CardContent>
          </Card>

          {/* Memory */}
          <Card>
            <CardHeader className="pb-1 pt-3 px-3">
              <CardTitle className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex items-center gap-1.5">
                <MemoryStick size={12} className="opacity-50" />
                Memory
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <MetricBar value={`${m.memUsedGb}`} total={`${m.memTotalGb}`} unit="GB" pct={m.memPct} />
            </CardContent>
          </Card>

          {/* Disk */}
          <Card>
            <CardHeader className="pb-1 pt-3 px-3">
              <CardTitle className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex items-center gap-1.5">
                <HardDrive size={12} className="opacity-50" />
                Disk
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <MetricBar value={`${m.diskPct}`} unit="% used" pct={m.diskPct} />
            </CardContent>
          </Card>

          {/* Uptime */}
          <Card>
            <CardHeader className="pb-1 pt-3 px-3">
              <CardTitle className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex items-center gap-1.5">
                <Clock size={12} className="opacity-50" />
                Uptime
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div className="text-lg font-mono font-semibold text-foreground">{m.uptime || "-"}</div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-secondary/30 p-4 mb-5 text-[13px] text-muted-foreground">
          <Activity size={14} className="inline-block mr-1.5 opacity-50" />
          Metrics unavailable - compute may be offline or provider does not support metrics.
        </div>
      )}

      {/* Tmux Sessions on this compute */}
      {snapshot?.sessions && snapshot.sessions.length > 0 && (
        <div className="mb-5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2 flex items-center gap-1.5">
            <Terminal size={12} className="opacity-50" />
            Tmux Sessions
          </h3>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-secondary/50 text-muted-foreground">
                  <th className="text-left px-3 py-1.5 font-semibold">Name</th>
                  <th className="text-left px-3 py-1.5 font-semibold">Status</th>
                  <th className="text-left px-3 py-1.5 font-semibold">Mode</th>
                  <th className="text-right px-3 py-1.5 font-semibold">CPU%</th>
                  <th className="text-right px-3 py-1.5 font-semibold">MEM%</th>
                  <th className="text-left px-3 py-1.5 font-semibold">Project</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.sessions.map((s) => (
                  <tr key={s.name} className="border-t border-border/50 hover:bg-accent/30 transition-colors">
                    <td className="px-3 py-1.5 font-mono text-foreground">{s.name}</td>
                    <td className="px-3 py-1.5">
                      <Badge variant={s.status === "attached" ? "default" : "secondary"} className="text-[10px]">
                        {s.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{s.mode}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground">{s.cpu.toFixed(1)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground">{s.mem.toFixed(1)}</td>
                    <td
                      className="px-3 py-1.5 font-mono text-muted-foreground truncate max-w-[200px]"
                      title={s.projectPath}
                    >
                      {s.projectPath ? s.projectPath.replace(/^\/Users\/[^/]+\//, "~/") : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Ark Sessions assigned to this compute */}
      {computeSessions.length > 0 && (
        <div className="mb-5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            Sessions on this Compute
          </h3>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-secondary/50 text-muted-foreground">
                  <th className="text-left px-3 py-1.5 font-semibold">Session</th>
                  <th className="text-left px-3 py-1.5 font-semibold">Summary</th>
                  <th className="text-left px-3 py-1.5 font-semibold">Status</th>
                  <th className="text-left px-3 py-1.5 font-semibold">Agent</th>
                </tr>
              </thead>
              <tbody>
                {computeSessions.map((s: any) => (
                  <tr key={s.session_id} className="border-t border-border/50 hover:bg-accent/30 transition-colors">
                    <td className="px-3 py-1.5 font-mono text-foreground">{s.session_id}</td>
                    <td className="px-3 py-1.5 text-foreground truncate max-w-[250px]">{s.summary || "-"}</td>
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-1.5">
                        <span className={cn("w-1.5 h-1.5 rounded-full", statusDotColor(s.status))} />
                        <span className="text-muted-foreground">{s.status}</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{s.agent || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Processes */}
      {(arkProcs.length > 0 || otherProcs.length > 0) && (
        <div className="mb-5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            Top Processes
          </h3>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-secondary/50 text-muted-foreground">
                  <th className="text-left px-3 py-1.5 font-semibold">PID</th>
                  <th className="text-left px-3 py-1.5 font-semibold">Command</th>
                  <th className="text-right px-3 py-1.5 font-semibold">CPU%</th>
                  <th className="text-right px-3 py-1.5 font-semibold">MEM%</th>
                </tr>
              </thead>
              <tbody>
                {arkProcs.map((p) => (
                  <tr key={p.pid} className="border-t border-border/50 hover:bg-accent/30 transition-colors">
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">{p.pid}</td>
                    <td className="px-3 py-1.5 font-mono text-foreground truncate max-w-[350px]" title={p.command}>
                      {p.command.length > 80 ? p.command.slice(0, 80) + "..." : p.command}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground">{p.cpu}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground">{p.mem}</td>
                  </tr>
                ))}
                {otherProcs.length > 0 && (
                  <tr className="border-t border-border/50 bg-secondary/20">
                    <td colSpan={4} className="px-3 py-1.5 text-muted-foreground italic">
                      + {otherProcs.length} other process{otherProcs.length === 1 ? "" : "es"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Docker Containers */}
      {snapshot?.docker && snapshot.docker.length > 0 && (
        <div className="mb-5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2 flex items-center gap-1.5">
            <Container size={12} className="opacity-50" />
            Docker Containers
          </h3>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-secondary/50 text-muted-foreground">
                  <th className="text-left px-3 py-1.5 font-semibold">Name</th>
                  <th className="text-left px-3 py-1.5 font-semibold">Image</th>
                  <th className="text-right px-3 py-1.5 font-semibold">CPU</th>
                  <th className="text-right px-3 py-1.5 font-semibold">Memory</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.docker.map((c) => (
                  <tr key={c.name} className="border-t border-border/50 hover:bg-accent/30 transition-colors">
                    <td className="px-3 py-1.5 font-mono text-foreground">{c.name}</td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground truncate max-w-[200px]">{c.image}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground">{c.cpu}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground">{c.memory}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Connection Info */}
      <div className="mb-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
          Connection Info
        </h3>
        <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
          <span className="text-muted-foreground">Provider</span>
          <span className="text-card-foreground font-mono">{compute.provider || compute.type || "-"}</span>
          {compute.ip && (
            <>
              <span className="text-muted-foreground">IP</span>
              <span className="text-card-foreground font-mono">{compute.ip}</span>
            </>
          )}
          {compute.config?.ip && (
            <>
              <span className="text-muted-foreground">IP</span>
              <span className="text-card-foreground font-mono">{compute.config.ip}</span>
            </>
          )}
          {compute.config?.publicIp && !compute.config?.ip && (
            <>
              <span className="text-muted-foreground">Public IP</span>
              <span className="text-card-foreground font-mono">{compute.config.publicIp}</span>
            </>
          )}
          {compute.instanceType && (
            <>
              <span className="text-muted-foreground">Instance</span>
              <span className="text-card-foreground font-mono">{compute.instanceType}</span>
            </>
          )}
          {compute.config?.instanceType && (
            <>
              <span className="text-muted-foreground">Instance</span>
              <span className="text-card-foreground font-mono">{compute.config.instanceType}</span>
            </>
          )}
          {(compute.region || compute.config?.region) && (
            <>
              <span className="text-muted-foreground">Region</span>
              <span className="text-card-foreground font-mono">{compute.region || compute.config?.region}</span>
            </>
          )}
          {compute.config?.hourlyRate != null && (
            <>
              <span className="text-muted-foreground">Hourly Rate</span>
              <span className="text-card-foreground font-mono">${compute.config.hourlyRate}/hr</span>
            </>
          )}
          {compute.created_at && (
            <>
              <span className="text-muted-foreground">Created</span>
              <span className="text-card-foreground">{new Date(compute.created_at).toLocaleString()}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main View ───────────────────────────────────────────────────────────────

interface ComputeViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
}

const MAX_HISTORY = 60; // 5 min at 5s intervals

export function ComputeView({ showCreate = false, onCloseCreate }: ComputeViewProps) {
  const queryClient = useQueryClient();
  const { data: computes = [] } = useComputeQuery();
  const [selected, setSelected] = useState<any>(null);
  const [actionMsg, setActionMsg] = useState<{ text: string; type: string } | null>(null);
  const [snapshot, setSnapshot] = useState<ComputeSnapshot | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const cpuHistoryRef = useRef<Map<string, CpuHistoryPoint[]>>(new Map());
  const [cpuHistory, setCpuHistory] = useState<CpuHistoryPoint[]>([]);

  // Fetch sessions for compute assignment
  useEffect(() => {
    api
      .getSessions({ status: "running" })
      .then(setSessions)
      .catch(() => {});
  }, []);

  // Fetch snapshot for selected compute
  const loadSnapshot = useCallback(() => {
    if (!selected) {
      setSnapshot(null);
      return;
    }
    const name = selected.name || selected.id;
    api
      .getComputeSnapshot(name === "local" ? undefined : name)
      .then((snap) => {
        setSnapshot(snap);
        if (snap?.metrics) {
          const key = name;
          const history = cpuHistoryRef.current.get(key) ?? [];
          history.push({ t: Date.now(), cpu: snap.metrics.cpu, mem: snap.metrics.memPct });
          if (history.length > MAX_HISTORY) history.shift();
          cpuHistoryRef.current.set(key, history);
          setCpuHistory([...history]);
        }
      })
      .catch(() => setSnapshot(null));
  }, [selected]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  useSmartPoll(loadSnapshot, 5000);

  // Also refresh sessions periodically
  useSmartPoll(
    useCallback(() => {
      api
        .getSessions({ status: "running" })
        .then(setSessions)
        .catch(() => {});
    }, []),
    15000,
  );

  async function handleAction(action: string) {
    if (!selected) return;
    const name = selected.name || selected.id;
    try {
      let res: any;
      switch (action) {
        case "provision":
          res = await api.provisionCompute(name);
          break;
        case "start":
          res = await api.startCompute(name);
          break;
        case "stop":
          res = await api.stopCompute(name);
          break;
        case "destroy":
          res = await api.destroyCompute(name);
          break;
        case "delete":
          res = await api.deleteCompute(name);
          break;
        default:
          return;
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
      const config: any = { ...(form.templateConfig ?? {}) };
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
                (selected?.name || selected?.id) === (c.name || c.id) &&
                  "bg-accent border-l-2 border-l-primary font-semibold",
              )}
              onClick={() => setSelected(c)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={cn("inline-block w-2 h-2 rounded-full shrink-0", statusDotColor(c.status || "unknown"))}
                />
                <span className="text-foreground truncate">{c.name || c.id}</span>
              </div>
              <Badge variant="secondary" className="text-[10px] shrink-0 ml-2">
                {c.provider || c.type || "local"}
              </Badge>
            </div>
          ))}
        </div>
        {/* Right: detail panel or create form */}
        <div className="overflow-y-auto bg-background">
          {showCreate ? (
            <NewComputeForm onClose={() => onCloseCreate?.()} onSubmit={handleCreate} />
          ) : selected ? (
            <ComputeDetailPanel
              compute={selected}
              snapshot={snapshot}
              cpuHistory={cpuHistory}
              sessions={sessions}
              onAction={handleAction}
              actionMsg={actionMsg}
            />
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
