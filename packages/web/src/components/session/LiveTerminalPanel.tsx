/**
 * LiveTerminalPanel -- xterm.js + server-daemon WS bridge.
 *
 * Wave 2 of the terminal-attach feature. Connects to `/terminal/:sessionId`
 * on the server daemon (:19400). Lazy mount: only opens the socket while
 * `isActive` is true so users who never click the tab don't pay for it.
 *
 * Contrast with the hosted `components/Terminal.tsx` component, which
 * connects to the web server's `/api/terminal` bridge on the web port.
 * Both exist for now; the new component is the MVP for #396 and drives a
 * different tab label ("Live terminal") until the two bridges converge.
 */

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "../ui/button.js";
import { useTerminalSocket } from "../../hooks/useTerminalSocket.js";

interface LiveTerminalPanelProps {
  sessionId: string;
  /** Parent tells us whether the panel is visible; we skip the WS while hidden. */
  isActive: boolean;
  /** Shown as a fallback when the socket refuses to connect (e.g. no pane). */
  fallback?: React.ReactNode;
}

export function LiveTerminalPanel({ sessionId, isActive, fallback }: LiveTerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const { status, errorMessage, sendInput, sendResize, retry } = useTerminalSocket({
    sessionId,
    enabled: isActive,
    onData: (bytes) => {
      termRef.current?.write(bytes);
    },
    onInitialBuffer: (buffer) => {
      termRef.current?.write(buffer);
    },
  });

  // Mount the xterm instance once per isActive transition. We don't keep it
  // around while the panel is hidden because terminals are expensive to hold
  // in memory and the pane-capture prepaint brings the user back to parity.
  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
      theme: {
        background: "#0a0a0a",
        foreground: "#e4e4e7",
        cursor: "#e4e4e7",
        selectionBackground: "#3f3f46",
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      /* container may be 0x0 pre-paint */
    }
    termRef.current = term;
    fitRef.current = fit;

    // Forward keystrokes to the socket.
    const inputDisposable = term.onData((data) => {
      sendInput(data);
    });

    // Propagate resize events.
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      const dims = fit.proposeDimensions();
      if (dims) sendResize(dims.cols, dims.rows);
    });
    resizeObserver.observe(containerRef.current);

    // Send the first resize once we know the real dimensions.
    const dims = fit.proposeDimensions();
    if (dims) sendResize(dims.cols, dims.rows);

    return () => {
      inputDisposable.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [isActive, sendInput, sendResize]);

  const statusLabel =
    status === "connecting"
      ? "Connecting..."
      : status === "connected"
        ? "Live"
        : status === "error"
          ? errorMessage || "Error"
          : status === "disconnected"
            ? "Disconnected"
            : "Idle";

  const statusColor =
    status === "connected"
      ? "text-[var(--running)]"
      : status === "error"
        ? "text-[var(--failed)]"
        : "text-[var(--fg-faint)]";

  return (
    <div
      className="flex flex-col w-full h-full border border-border rounded-lg overflow-hidden bg-[#0a0a0a]"
      data-testid="live-terminal-panel"
    >
      <div className="flex items-center justify-between px-3 py-1.5 bg-secondary border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Live terminal
          </span>
          <span className={`text-[10px] ${statusColor}`} data-testid="live-terminal-status">
            {statusLabel}
          </span>
        </div>
        {status === "error" && (
          <Button
            variant="ghost"
            size="xs"
            onClick={retry}
            className="h-5 px-1.5 text-[10px]"
            data-testid="live-terminal-retry"
          >
            Retry
          </Button>
        )}
      </div>
      {status === "error" && fallback ? (
        <div className="p-4 text-[12px] text-[var(--fg-faint)]">{fallback}</div>
      ) : (
        <div ref={containerRef} className="flex-1 min-h-0 w-full" style={{ padding: "4px" }} />
      )}
    </div>
  );
}
