import { cn } from "../../lib/utils.js";
import { Badge } from "../ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js";
import { Cpu, HardDrive, MemoryStick, Clock, Container, Terminal, Activity } from "lucide-react";
import { statusDotColor, pctColor, isArkProcess } from "./helpers.js";
import { MetricBar } from "./MetricBar.js";
import { MetricSparkline } from "./MetricSparkline.js";
import { MetricsSkeleton } from "./MetricsSkeleton.js";
import { ComputeActions } from "./ComputeActions.js";
import type { ComputeSnapshot, MetricHistoryPoint } from "./types.js";

export function ComputeDetailPanel({
  compute,
  snapshot,
  metricHistory,
  sessions,
  onAction,
  actionMsg,
  metricsState,
  onRetryMetrics,
}: {
  compute: any;
  snapshot: ComputeSnapshot | null;
  metricHistory: MetricHistoryPoint[];
  sessions: any[];
  onAction: (action: string) => void;
  actionMsg: { text: string; type: string } | null;
  metricsState: "loading" | "loaded" | "error";
  onRetryMetrics: () => void;
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
      {metricsState === "loading" && !m && <MetricsSkeleton />}
      {metricsState === "error" && !m && (
        <div className="rounded-lg border border-border bg-secondary/30 p-4 mb-5 text-[13px] text-muted-foreground flex items-center gap-2">
          <Activity size={14} className="opacity-50" />
          <span>Could not reach arkd</span>
          <button
            type="button"
            onClick={onRetryMetrics}
            className="ml-2 text-[11px] font-medium text-primary hover:underline cursor-pointer bg-transparent border-none"
            aria-label="Retry loading metrics"
          >
            Retry
          </button>
        </div>
      )}
      {m && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
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
              <MetricSparkline
                history={metricHistory}
                dataKey="cpu"
                gradientId="cpuGrad"
                color="var(--primary, #7c6aef)"
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1 pt-3 px-3">
              <CardTitle className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex items-center gap-1.5">
                <MemoryStick size={12} className="opacity-50" />
                Memory
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <MetricBar value={`${m.memUsedGb}`} total={`${m.memTotalGb}`} unit="GB" pct={m.memPct} />
              <MetricSparkline
                history={metricHistory}
                dataKey="mem"
                gradientId="memGrad"
                color="var(--running, #34d399)"
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1 pt-3 px-3">
              <CardTitle className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex items-center gap-1.5">
                <HardDrive size={12} className="opacity-50" />
                Disk
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <MetricBar value={`${m.diskPct}`} unit="% used" pct={m.diskPct} />
              <MetricSparkline
                history={metricHistory}
                dataKey="disk"
                gradientId="diskGrad"
                color="var(--waiting, #fbbf24)"
              />
            </CardContent>
          </Card>
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
