/**
 * Embedded web terminal -- connects to a tmux session via WebSocket.
 *
 * Uses @xterm/xterm for rendering and the /api/terminal WebSocket endpoint
 * for bidirectional I/O with the tmux pane.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "./ui/button.js";

interface TerminalProps {
  sessionId: string;
  onClose: () => void;
}

function buildWsUrl(sessionId: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = new URLSearchParams(window.location.search).get("token");
  let url = `${proto}//${window.location.host}/api/terminal?session=${sessionId}`;
  if (token) url += `&token=${token}`;
  return url;
}

export function TerminalPanel({ sessionId, onClose }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!containerRef.current) return;

    // Create terminal instance
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
      theme: {
        background: "#0a0a0a",
        foreground: "#e4e4e7",
        cursor: "#e4e4e7",
        selectionBackground: "#3f3f46",
        black: "#09090b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#fafafa",
      },
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // Connect WebSocket
    const ws = new WebSocket(buildWsUrl(sessionId));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connecting");
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "connected") {
            setStatus("connected");
            // Send initial resize
            const dims = fit.proposeDimensions();
            if (dims) {
              ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
            }
            return;
          }
          if (msg.type === "error") {
            setStatus("error");
            setErrorMsg(msg.message);
            return;
          }
          if (msg.type === "disconnected") {
            setStatus("disconnected");
            return;
          }
        } catch {
          // Not JSON -- write as text
          term.write(event.data);
        }
      } else {
        // Binary data -- raw terminal output
        term.write(new Uint8Array(event.data));
      }
    };

    ws.onclose = () => {
      if (status !== "error") setStatus("disconnected");
    };

    ws.onerror = () => {
      setStatus("error");
      setErrorMsg("WebSocket connection failed");
    };

    // Forward terminal input to WebSocket
    const inputDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        // Send as binary for raw terminal input
        ws.send(new TextEncoder().encode(data));
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        const dims = fit.proposeDimensions();
        if (dims) {
          ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      inputDisposable.dispose();
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  const statusColor = {
    connecting: "text-yellow-400",
    connected: "text-emerald-400",
    disconnected: "text-muted-foreground",
    error: "text-red-400",
  }[status];

  const statusLabel = {
    connecting: "Connecting...",
    connected: "Connected",
    disconnected: "Disconnected",
    error: errorMsg || "Error",
  }[status];

  return (
    <div className="flex flex-col border border-border rounded-lg overflow-hidden bg-[#0a0a0a]">
      {/* Terminal header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-secondary border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Terminal</span>
          <span className={`text-[10px] ${statusColor}`}>{statusLabel}</span>
        </div>
        <Button variant="ghost" size="xs" onClick={onClose} className="h-5 px-1.5 text-[10px]">
          Close
        </Button>
      </div>
      {/* Terminal container */}
      <div
        ref={containerRef}
        className="w-full"
        style={{ height: "360px", padding: "4px" }}
      />
    </div>
  );
}
