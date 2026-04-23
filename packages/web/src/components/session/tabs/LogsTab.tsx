import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../hooks/useApi.js";
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
 *
 * Terminal-panel treatment matches the DiffViewer: traffic-light dots in
 * the header, mono "stdio · <id>" chip, and the log body in a gutter-lined
 * monospace pre.
 */
export function LogsTab({ sessionId, status }: LogsTabProps) {
  const [tailMode, setTailMode] = useState<boolean>(true);
  const [autoscroll, setAutoscroll] = useState<boolean>(true);
  const preRef = useRef<HTMLPreElement | null>(null);

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
    <div data-testid="logs-tab" className="flex flex-col gap-[10px] max-w-full">
      <div
        className={cn(
          "relative overflow-hidden rounded-[9px] border border-[var(--border)]",
          "bg-[linear-gradient(180deg,rgba(255,255,255,0.04)_0%,rgba(255,255,255,0)_20%,rgba(0,0,0,0.15)_100%),var(--bg-card)]",
          "border-t-[rgba(255,255,255,0.08)] border-b-[rgba(0,0,0,0.5)]",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-1px_0_rgba(0,0,0,0.45),0_1px_2px_rgba(0,0,0,0.45),0_10px_22px_-6px_rgba(0,0,0,0.4)]",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-[8px] px-[12px] py-[8px] border-b border-[var(--border)]",
            "bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(0,0,0,0.1))]",
            "font-[family-name:var(--font-mono-ui)] text-[10.5px] font-medium text-[var(--fg-muted)]",
          )}
        >
          <TrafficDot color="#f87171" />
          <TrafficDot color="#fbbf24" />
          <TrafficDot color="#34d399" />
          <span
            data-testid="logs-header-chip"
            className={cn(
              "inline-flex items-center gap-[5px] px-[7px] py-[3px] rounded-[4px]",
              "text-[var(--fg)]",
              "bg-[linear-gradient(180deg,#1f1f35,#181829)]",
              "border border-[var(--border)] border-t-[rgba(255,255,255,0.08)]",
              "shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.3)]",
            )}
          >
            stdio · {shortId}
          </span>
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
          <div
            className="px-[12px] py-[24px] text-center text-[12px] text-[var(--fg-faint)] font-[family-name:var(--font-mono)]"
            data-testid="logs-empty"
          >
            <div>No logs yet</div>
            {status && <div className="mt-[4px] text-[10.5px] uppercase tracking-[0.05em]">status · {status}</div>}
          </div>
        )}

        {lines.length > 0 && (
          <pre
            ref={preRef}
            data-testid="logs-body"
            className={cn(
              "m-0 px-0 py-[10px] whitespace-pre overflow-auto max-h-[60vh]",
              "font-[family-name:var(--font-mono)] text-[11px] leading-[18px] text-[var(--fg)]",
              "bg-[linear-gradient(180deg,rgba(0,0,0,0.2)_0%,rgba(0,0,0,0)_6%),var(--bg-code)]",
              "shadow-[inset_0_2px_4px_rgba(0,0,0,0.35)]",
            )}
          >
            {lines.map((ln, i) => {
              const isExec = ln.trimStart().startsWith("[exec ");
              return (
                <div key={i} className="flex">
                  <span className="inline-block w-[48px] pr-[10px] text-right text-[var(--fg-faint)] select-none shrink-0">
                    {i + 1}
                  </span>
                  <span
                    className={cn(
                      "whitespace-pre flex-1 min-w-0",
                      isExec ? "text-[var(--fg-muted)]" : "text-[var(--fg)]",
                    )}
                  >
                    {ln || " "}
                  </span>
                </div>
              );
            })}
          </pre>
        )}
      </div>
    </div>
  );
}

function TrafficDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="w-[6px] h-[6px] rounded-full shrink-0"
      style={{ backgroundColor: color, boxShadow: `0 0 3px ${color}99` }}
    />
  );
}
