import { useEffect, useState, useCallback } from "react";
import { X, Skull, Square, RotateCcw, ExternalLink, Terminal, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { api } from "../../hooks/useApi.js";
import { pctColor, isArkProcess } from "./helpers.js";
import type { SnapshotProcess, SnapshotSession, DockerContainer } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────

type DrawerKind = "process" | "docker" | "tmux";

export interface DrawerItem {
  kind: DrawerKind;
  process?: SnapshotProcess;
  docker?: DockerContainer;
  tmux?: SnapshotSession;
}

interface ComputeDrawerProps {
  item: DrawerItem | null;
  onClose: () => void;
  onNavigateToSession?: (sessionId: string) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractArkSessionId(command: string): string | null {
  const match = command.match(/ark-s-([\da-f]+)/i);
  return match ? `s-${match[1]}` : null;
}

function extractTmuxSessionId(name: string): string | null {
  const match = name.match(/^ark-s-([\da-f]+)/i);
  return match ? `s-${match[1]}` : null;
}

// ── Confirmation button ────────────────────────────────────────────────────

function ConfirmButton({
  label,
  confirmLabel,
  variant,
  icon,
  onConfirm,
  loading,
}: {
  label: string;
  confirmLabel: string;
  variant: "destructive" | "outline" | "default";
  icon: React.ReactNode;
  onConfirm: () => void;
  loading?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  if (loading) {
    return (
      <Button size="xs" variant={variant} disabled>
        <Loader2 size={12} className="animate-spin" />
        {label}...
      </Button>
    );
  }

  if (confirming) {
    return (
      <Button size="xs" variant="destructive" onClick={onConfirm}>
        {confirmLabel}
      </Button>
    );
  }

  return (
    <Button size="xs" variant={variant} onClick={() => setConfirming(true)}>
      {icon}
      {label}
    </Button>
  );
}

// ── Process detail ─────────────────────────────────────────────────────────

function ProcessDetail({
  process,
  onNavigateToSession,
  onClose,
}: {
  process: SnapshotProcess;
  onNavigateToSession?: (id: string) => void;
  onClose: () => void;
}) {
  const [killing, setKilling] = useState(false);
  const [killResult, setKillResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const arkSessionId = extractArkSessionId(process.command);

  const handleKill = useCallback(async () => {
    setKilling(true);
    try {
      await api.killProcess(process.pid);
      setKillResult({ ok: true, msg: "Process terminated" });
      setTimeout(onClose, 1500);
    } catch (err: any) {
      setKillResult({ ok: false, msg: err.message || "Failed to kill process" });
    } finally {
      setKilling(false);
    }
  }, [process.pid, onClose]);

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Process Details</h3>

      {/* Full command */}
      <div>
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Command</span>
        <pre className="mt-1 text-[12px] font-mono text-foreground bg-secondary/50 rounded-md p-2.5 whitespace-pre-wrap break-all leading-relaxed">
          {process.command}
        </pre>
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-[90px_1fr] gap-y-2 gap-x-3 text-[12px]">
        <span className="text-muted-foreground">PID</span>
        <span className="font-mono text-foreground">{process.pid}</span>

        <span className="text-muted-foreground">CPU%</span>
        <span className="font-mono font-semibold" style={{ color: pctColor(parseFloat(process.cpu) || 0) }}>
          {process.cpu}%
        </span>

        <span className="text-muted-foreground">MEM%</span>
        <span className="font-mono font-semibold" style={{ color: pctColor(parseFloat(process.mem) || 0) }}>
          {process.mem}%
        </span>

        {process.workingDir && (
          <>
            <span className="text-muted-foreground">Working Dir</span>
            <span className="font-mono text-foreground truncate" title={process.workingDir}>
              {process.workingDir}
            </span>
          </>
        )}

        <span className="text-muted-foreground">Type</span>
        <span className="text-foreground">
          {isArkProcess(process.command) ? (
            <Badge variant="default" className="text-[10px]">
              Ark
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px]">
              System
            </Badge>
          )}
        </span>
      </div>

      {/* Ark session link */}
      {arkSessionId && onNavigateToSession && (
        <button
          type="button"
          onClick={() => onNavigateToSession(arkSessionId)}
          className="flex items-center gap-1.5 text-[12px] text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
        >
          <ExternalLink size={12} />
          Go to session {arkSessionId}
        </button>
      )}

      {/* Kill button */}
      <div className="flex items-center gap-2 pt-1">
        <ConfirmButton
          label="Kill"
          confirmLabel="Confirm kill?"
          variant="destructive"
          icon={<Skull size={12} />}
          onConfirm={handleKill}
          loading={killing}
        />
        {killResult && (
          <span className={cn("text-[11px]", killResult.ok ? "text-[var(--running)]" : "text-[var(--failed)]")}>
            {killResult.msg}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Docker detail ──────────────────────────────────────────────────────────

function DockerDetail({ container, onClose }: { container: DockerContainer; onClose: () => void }) {
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Parse image into name:tag
  const imageParts = container.image.split(":");
  const imageName = imageParts[0];
  const imageTag = imageParts.slice(1).join(":") || "latest";

  // Load logs on mount
  useEffect(() => {
    setLogsLoading(true);
    setLogsError(null);
    api
      .getDockerLogs(container.name, 100)
      .then((l) => setLogs(l))
      .catch((err) => setLogsError(err.message || "Failed to load logs"))
      .finally(() => setLogsLoading(false));
  }, [container.name]);

  const handleAction = useCallback(
    async (action: "stop" | "restart") => {
      setActionLoading(action);
      setActionResult(null);
      try {
        await api.dockerAction(container.name, action);
        setActionResult({ ok: true, msg: `${action} successful` });
        if (action === "stop") {
          setTimeout(onClose, 1500);
        }
      } catch (err: any) {
        setActionResult({ ok: false, msg: err.message || `Failed to ${action}` });
      } finally {
        setActionLoading(null);
      }
    },
    [container.name, onClose],
  );

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Container Details</h3>

      {/* Info grid */}
      <div className="grid grid-cols-[90px_1fr] gap-y-2 gap-x-3 text-[12px]">
        <span className="text-muted-foreground">Name</span>
        <span className="font-mono text-foreground">{container.name}</span>

        <span className="text-muted-foreground">Image</span>
        <span className="font-mono text-foreground">{imageName}</span>

        <span className="text-muted-foreground">Tag</span>
        <span className="font-mono text-muted-foreground">{imageTag}</span>

        <span className="text-muted-foreground">CPU</span>
        <span className="font-mono font-semibold text-foreground">{container.cpu}</span>

        <span className="text-muted-foreground">Memory</span>
        <span className="font-mono font-semibold text-foreground">{container.memory}</span>

        {container.project && (
          <>
            <span className="text-muted-foreground">Project</span>
            <span className="font-mono text-foreground truncate" title={container.project}>
              {container.project}
            </span>
          </>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <ConfirmButton
          label="Stop"
          confirmLabel="Confirm stop?"
          variant="destructive"
          icon={<Square size={12} />}
          onConfirm={() => handleAction("stop")}
          loading={actionLoading === "stop"}
        />
        <ConfirmButton
          label="Restart"
          confirmLabel="Confirm restart?"
          variant="outline"
          icon={<RotateCcw size={12} />}
          onConfirm={() => handleAction("restart")}
          loading={actionLoading === "restart"}
        />
        {actionResult && (
          <span className={cn("text-[11px]", actionResult.ok ? "text-[var(--running)]" : "text-[var(--failed)]")}>
            {actionResult.msg}
          </span>
        )}
      </div>

      {/* Logs */}
      <div>
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Logs (last 100 lines)
        </span>
        <div className="mt-1 rounded-md bg-secondary/50 border border-border overflow-hidden">
          {logsLoading && (
            <div className="flex items-center gap-2 p-3 text-[12px] text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              Loading logs...
            </div>
          )}
          {logsError && <div className="p-3 text-[12px] text-[var(--failed)]">{logsError}</div>}
          {logs !== null && !logsLoading && (
            <pre className="p-2.5 text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto leading-relaxed">
              {logs || "(empty)"}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Tmux detail ────────────────────────────────────────────────────────────

function TmuxDetail({
  session,
  onNavigateToSession,
}: {
  session: SnapshotSession;
  onNavigateToSession?: (id: string) => void;
}) {
  const arkSessionId = extractTmuxSessionId(session.name);

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Tmux Session Details
      </h3>

      {/* Info grid */}
      <div className="grid grid-cols-[90px_1fr] gap-y-2 gap-x-3 text-[12px]">
        <span className="text-muted-foreground">Name</span>
        <span className="font-mono text-foreground">{session.name}</span>

        <span className="text-muted-foreground">Status</span>
        <span>
          <Badge variant={session.status === "attached" ? "default" : "secondary"} className="text-[10px]">
            {session.status}
          </Badge>
        </span>

        <span className="text-muted-foreground">Mode</span>
        <span className="font-mono text-foreground">{session.mode || "-"}</span>

        <span className="text-muted-foreground">CPU%</span>
        <span className="font-mono font-semibold" style={{ color: pctColor(session.cpu) }}>
          {session.cpu.toFixed(1)}%
        </span>

        <span className="text-muted-foreground">MEM%</span>
        <span className="font-mono font-semibold" style={{ color: pctColor(session.mem) }}>
          {session.mem.toFixed(1)}%
        </span>

        {session.projectPath && (
          <>
            <span className="text-muted-foreground">Project</span>
            <span className="font-mono text-foreground truncate" title={session.projectPath}>
              {session.projectPath.replace(/^\/Users\/[^/]+\//, "~/")}
            </span>
          </>
        )}
      </div>

      {/* Ark session link / attach */}
      {arkSessionId && onNavigateToSession && (
        <button
          type="button"
          onClick={() => onNavigateToSession(arkSessionId)}
          className="flex items-center gap-1.5 text-[12px] text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
        >
          <Terminal size={12} />
          Open session {arkSessionId} (Terminal)
        </button>
      )}
    </div>
  );
}

// ── Main drawer ────────────────────────────────────────────────────────────

export function ComputeDrawer({ item, onClose, onNavigateToSession }: ComputeDrawerProps) {
  // Close on Escape
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  const open = item !== null;

  return (
    <>
      {/* Overlay */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity duration-200",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div
        className={cn(
          "fixed top-0 right-0 z-50 h-full w-[380px] max-w-[90vw] bg-background border-l border-border shadow-xl",
          "transform transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-[13px] font-semibold text-foreground">
            {item?.kind === "process" && "Process"}
            {item?.kind === "docker" && "Container"}
            {item?.kind === "tmux" && "Tmux Session"}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer bg-transparent border-none p-1 rounded-md hover:bg-accent"
            aria-label="Close drawer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto h-[calc(100%-49px)]">
          {item?.kind === "process" && item.process && (
            <ProcessDetail process={item.process} onNavigateToSession={onNavigateToSession} onClose={onClose} />
          )}
          {item?.kind === "docker" && item.docker && <DockerDetail container={item.docker} onClose={onClose} />}
          {item?.kind === "tmux" && item.tmux && (
            <TmuxDetail session={item.tmux} onNavigateToSession={onNavigateToSession} />
          )}
        </div>
      </div>
    </>
  );
}
