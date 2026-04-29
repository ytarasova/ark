import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../../hooks/useApi.js";
import { cn } from "../../../lib/utils.js";
import { TerminalTab } from "./TerminalTab.js";

interface LogsTabProps {
  sessionId: string;
  /** Session status -- polling halts on terminal states. */
  status?: string | null;
  /** Pty cols/rows for the static terminal recording. */
  ptyCols?: number;
  ptyRows?: number;
  /** Static recording for finished sessions. */
  output?: string | null;
  /** True when the session is still active (drives live-terminal lazy mount). */
  isActive?: boolean;
  /** True when the parent tab is currently visible -- gates the live socket. */
  tabActive?: boolean;
}

type LogsSource = "stdio" | "terminal";

const TERMINAL_STATES = new Set(["completed", "failed", "stopped", "archived"]);
const POLL_INTERVAL_MS = 2000;
const TAIL_DEFAULT = 500;

/**
 * stdio.log viewer for a session. Fetches via `session/stdio` RPC on mount
 * and refetches every 2s while the session is running. Offers a tail toggle
 * (last 500 vs full file) and an autoscroll toggle so users reading older
 * output don't get yanked to the bottom mid-scroll.
 *
 * Terminal-panel treatment matches the DiffViewer: traffic-light dots in
 * the header, mono "stdio · <id>" chip, and the log body in a gutter-lined
 * monospace pre.
 *
 * Now also hosts the Live Terminal as a segmented sub-tab. The previous
 * top-level Terminal tab was retired (both surfaces are runtime output --
 * stdio is the captured log, terminal is the interactive xterm) so they
 * share one tab with a `Logs / Live terminal` toggle. The terminal segment
 * mounts lazily (only when its segment is selected) so the live xterm
 * WebSocket isn't opened on every Logs tab visit.
 */
export function LogsTab({ sessionId, status, ptyCols, ptyRows, output, isActive, tabActive }: LogsTabProps) {
  const [tailMode, setTailMode] = useState<boolean>(true);
  const [autoscroll, setAutoscroll] = useState<boolean>(true);
  // Logs vs Live Terminal segmented toggle. We default to stdio because the
  // live xterm carries a WebSocket cost and most users land here for plain
  // log scrolling. The terminal segment mounts lazily on first selection.
  const [source, setSource] = useState<LogsSource>("stdio");

  const preRef = useRef<HTMLPreElement | null>(null);
  const api = useApi();

  const isRunning = !!status && !TERMINAL_STATES.has(status);
  const tail = tailMode ? TAIL_DEFAULT : undefined;

  const query = useQuery({
    queryKey: ["session-stdio", sessionId, tail ?? "all"],
    queryFn: () => api.getStdio(sessionId, tail ? { tail } : undefined),
    refetchInterval: isRunning ? POLL_INTERVAL_MS : false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const lines = useMemo<string[]>(() => {
    const content = query.data?.content ?? "";
    if (!content) return [];
    // Split but drop the trailing empty remnant when the file ended in \n.
    const parts = content.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts;
  }, [query.data]);

  useEffect(() => {
    if (!autoscroll) return;
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, autoscroll]);

  const shortId = sessionId.length > 14 ? sessionId.slice(0, 8) + "..." + sessionId.slice(-4) : sessionId;

  return (
    <div data-testid="logs-tab" className="flex flex-col gap-[10px] max-w-full flex-1 min-h-0">
      <SegmentedControl source={source} onChange={setSource} />
      {source === "terminal" ? (
        <div data-testid="logs-tab-terminal" className="flex-1 min-h-[360px]">
          <TerminalTab
            sessionId={sessionId}
            output={output ?? null}
            cols={ptyCols}
            rows={ptyRows}
            isActive={isActive ?? false}
            tabActive={!!tabActive}
          />
        </div>
      ) : (
        <div data-testid="logs-tab-stdio" className="panel-card">
          <div className="panel-card-header">
            <span className="panel-traffic-dot red" aria-hidden />
            <span className="panel-traffic-dot amber" aria-hidden />
            <span className="panel-traffic-dot green" aria-hidden />
            <span data-testid="logs-header-chip" className="panel-card-chip">
              stdio · {shortId}
            </span>
            {isRunning && (
              <span
                className="text-[9.5px] uppercase tracking-[0.05em] text-[#86efac]"
                data-testid="logs-live-indicator"
              >
                live
              </span>
            )}
            <div className="ml-auto flex items-center gap-[6px]">
              <button
                type="button"
                onClick={() => setTailMode((t) => !t)}
                className={cn(
                  "px-[8px] py-[3px] rounded-[4px] text-[10px] font-[family-name:var(--font-mono-ui)]",
                  "border border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]",
                  "bg-[rgba(0,0,0,0.2)]",
                )}
                data-testid="logs-tail-toggle"
              >
                {tailMode ? `Last ${TAIL_DEFAULT}` : "All"}
              </button>
              <label className="flex items-center gap-[4px] text-[10px] text-[var(--fg-muted)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoscroll}
                  onChange={(e) => setAutoscroll(e.target.checked)}
                  className="w-[11px] h-[11px]"
                  data-testid="logs-autoscroll-toggle"
                />
                autoscroll
              </label>
            </div>
          </div>

          {query.isError && (
            <div className="px-[12px] py-[10px] text-[11px] text-[#f87171]" data-testid="logs-error">
              Failed to load stdio: {(query.error as Error)?.message ?? "unknown error"}
            </div>
          )}

          {!query.isError && lines.length === 0 && (
            <div className="panel-card-empty" data-testid="logs-empty">
              <div>No logs yet</div>
              {status && <div className="panel-card-empty-meta">status · {status}</div>}
            </div>
          )}

          {lines.length > 0 && (
            <pre ref={preRef} data-testid="logs-body" className="panel-log-body">
              {lines.map((ln, i) => {
                const isExec = ln.trimStart().startsWith("[exec ");
                return (
                  <div key={i} className="panel-log-line">
                    <span className="panel-log-gutter">{i + 1}</span>
                    <span className={cn("panel-log-content", isExec && "muted")}>{ln || " "}</span>
                  </div>
                );
              })}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Two-button segmented control rendered above the Logs/Terminal panels.
 * Lazily mounts each segment so the live xterm WebSocket stays closed
 * until the user explicitly switches to it.
 */
function SegmentedControl({ source, onChange }: { source: LogsSource; onChange: (s: LogsSource) => void }) {
  const seg = (id: LogsSource, label: string) => (
    <button
      key={id}
      type="button"
      data-testid={`logs-segment-${id}`}
      aria-pressed={source === id}
      onClick={() => onChange(id)}
      className={cn(
        "px-[10px] py-[3px] rounded-[4px] text-[11px] font-[family-name:var(--font-mono-ui)]",
        "border border-transparent transition-colors cursor-pointer",
        source === id
          ? "bg-[var(--bg-hover)] text-[var(--fg)] border-[var(--border)]"
          : "text-[var(--fg-muted)] hover:text-[var(--fg)]",
      )}
    >
      {label}
    </button>
  );
  return (
    <div
      data-testid="logs-segmented-control"
      role="tablist"
      aria-label="Logs source"
      className="inline-flex gap-[2px] p-[2px] rounded-[6px] bg-[rgba(0,0,0,0.2)] self-start"
    >
      {seg("stdio", "Logs")}
      {seg("terminal", "Live terminal")}
    </div>
  );
}

