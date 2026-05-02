/**
 * LiveTerminalPanel -- xterm.js + server-daemon WS bridge.
 *
 * Connects to `/terminal/:sessionId` on the server daemon (:19400). Lazy
 * open: the socket only connects while `isActive` is true so users who
 * never click the tab don't pay for a live WS. The xterm instance stays
 * mounted while the panel is hidden (display: none) so scrollback,
 * selection, and viewport position survive tab switches within the same
 * session detail view -- the socket is torn down, but nothing else.
 *
 * Theming:
 *   - 14px monospace using `fontStacks.mono` from the design tokens
 *   - dark background (matches the design spec's terminal-noir palette)
 *   - 10k scrollback
 *
 * Keybindings:
 *   - Copy-on-select (auto, 100ms debounce) -- no explicit Cmd+C needed
 *   - Cmd+V / Ctrl+Shift+V paste from clipboard
 */

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "../ui/button.js";
import { useTerminalSocket } from "../../hooks/useTerminalSocket.js";
import { fontStacks } from "../../themes/typography.js";
import { buildTerminalTheme } from "../../themes/terminal-theme.js";
import { useTheme } from "../../themes/ThemeProvider.js";

interface LiveTerminalPanelProps {
  sessionId: string;
  /** Parent tells us whether the panel is visible; we skip the WS while hidden. */
  isActive: boolean;
  /** Shown as a fallback when the socket refuses to connect (e.g. no pane). */
  fallback?: React.ReactNode;
}

const RESIZE_DEBOUNCE_MS = 100;
const COPY_DEBOUNCE_MS = 100;
const SCROLLBACK_LINES = 10_000;

export function LiveTerminalPanel({ sessionId, isActive, fallback }: LiveTerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { themeName, colorMode } = useTheme();

  const { status, errorMessage, reconnectAttempt, maxReconnectAttempts, sendInput, sendResize, retry, disconnect } =
    useTerminalSocket({
      sessionId,
      enabled: isActive,
      onData: (bytes) => {
        termRef.current?.write(bytes);
      },
      onInitialBuffer: (buffer) => {
        termRef.current?.write(buffer);
      },
    });

  // Mount the xterm instance once, and keep it alive for the panel's lifetime
  // (not tied to `isActive`) so scrollback / selection survive tab switches.
  // The socket lifecycle above handles the WS lazy-mount independently.
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: fontStacks.mono,
      scrollback: SCROLLBACK_LINES,
      // overviewRuler.width also sets the scrollbar gutter width (default 14
      // produces the chunky default-OS-looking thumb). Match the app's
      // global 6px scrollbar instead.
      overviewRuler: { width: 6 },
      // Live terminal: cursor uses the foreground colour so it stays
      // visible against the canvas. Both come from the active theme.
      theme: (() => {
        const base = buildTerminalTheme();
        return { ...base, cursor: base.foreground };
      })(),
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

    // Copy-on-select. `onSelectionChange` fires on every char while the user
    // is dragging; debouncing keeps us off the clipboard until selection
    // settles. Empty selection is the "cleared" signal -- skip.
    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    const selectionDisposable = term.onSelectionChange(() => {
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        const text = term.getSelection();
        if (!text) return;
        try {
          navigator.clipboard?.writeText(text).catch(() => {
            /* insecure origin or permissions denied -- no-op */
          });
        } catch {
          /* older browsers without async clipboard */
        }
      }, COPY_DEBOUNCE_MS);
    });

    // Paste via Cmd+V (mac) or Ctrl+Shift+V (linux/windows). We intercept
    // in `attachCustomKeyEventHandler` to prevent xterm from interpreting
    // the raw keystroke, then send the clipboard contents back over the WS.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const isMac = typeof navigator !== "undefined" && navigator.platform?.toLowerCase().includes("mac");
      const macPaste = isMac && ev.metaKey && !ev.ctrlKey && !ev.altKey && ev.key.toLowerCase() === "v";
      const linuxPaste = !isMac && ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "v";
      if (macPaste || linuxPaste) {
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) sendInput(text);
          })
          .catch(() => {
            /* clipboard permission denied -- swallow */
          });
        return false;
      }
      return true;
    });

    // Propagate resize events to the server. Debounce so rapid window resizes
    // don't flood tmux with resize-window calls.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
        const dims = fit.proposeDimensions();
        if (dims) sendResize(dims.cols, dims.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(containerRef.current);

    // Send the first resize once we know the real dimensions.
    const dims = fit.proposeDimensions();
    if (dims) sendResize(dims.cols, dims.rows);

    return () => {
      if (copyTimer) clearTimeout(copyTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      inputDisposable.dispose();
      selectionDisposable.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Intentionally not re-running on isActive -- the panel keeps its xterm
    // instance alive across tab switches and only tears down on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live theme reactivity: ThemeProvider has already pushed the new CSS
  // variables to :root by the time this effect runs, so buildTerminalTheme()
  // reads the active token set. Assigning to term.options.theme triggers
  // an internal repaint with no remount.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const base = buildTerminalTheme();
    term.options.theme = { ...base, cursor: base.foreground };
  }, [themeName, colorMode]);

  // Status pill: driven by the hook's state machine. Includes the current
  // reconnect attempt number while the backoff timer is running.
  const statusLabel =
    status === "connecting"
      ? "Connecting..."
      : status === "connected"
        ? "Live"
        : status === "reconnecting"
          ? `Reconnecting ${reconnectAttempt}/${maxReconnectAttempts}...`
          : status === "error"
            ? errorMessage || "Error"
            : status === "disconnected"
              ? "Disconnected"
              : "Idle";

  const statusColor =
    status === "connected" ? "running" : status === "error" ? "failed" : status === "reconnecting" ? "waiting" : "idle";

  return (
    <div className="panel-card" data-testid="live-terminal-panel" style={{ display: isActive ? undefined : "none" }}>
      <div className="panel-card-header">
        <span className={`panel-status ${statusColor}`} data-testid="live-terminal-status">
          {statusLabel}
        </span>
        <div className="ml-auto flex items-center gap-[6px]">
          {(status === "connected" || status === "connecting" || status === "reconnecting") && (
            <Button
              variant="ghost"
              size="xs"
              onClick={disconnect}
              className="h-5 px-1.5 text-[10px]"
              data-testid="live-terminal-disconnect"
            >
              Disconnect
            </Button>
          )}
          {(status === "error" || status === "disconnected") && (
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
      </div>
      {status === "error" && fallback ? (
        <div className="panel-card-empty">{fallback}</div>
      ) : (
        <div ref={containerRef} className="terminal-host" />
      )}
    </div>
  );
}
