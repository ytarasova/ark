import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../../hooks/useApi.js";
import { cn } from "../../../lib/utils.js";

interface LogsTabProps {
  sessionId: string;
  /** Session status -- polling halts on terminal states. */
  status?: string | null;
}

const TERMINAL_STATES = new Set(["completed", "failed", "stopped", "archived"]);
const POLL_INTERVAL_MS = 2000;
const TAIL_DEFAULT = 500;

/**
 * stdio.log viewer for a session. Fetches via `session/stdio` RPC on mount
 * and refetches every 2s while the session is running. Offers a tail toggle
 * (last 500 vs full file) and an autoscroll toggle so users reading older
 * output don't get yanked to the bottom mid-scroll.
 */
export function LogsTab({ sessionId, status }: LogsTabProps) {
  const [tailMode, setTailMode] = useState<boolean>(true);
  const [autoscroll, setAutoscroll] = useState<boolean>(true);

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

  return (
    <div data-testid="logs-tab" className="panel-card">
      <div className="panel-card-header">
        {isRunning && (
          <span className="text-[9.5px] uppercase tracking-[0.05em] text-[#86efac]" data-testid="logs-live-indicator">
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
  );
}
