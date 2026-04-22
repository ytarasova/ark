/**
 * useTerminalSocket -- WebSocket bridge to /terminal/:sessionId on the
 * server daemon. Lazy-mounts the socket (only opens when `enabled` flips to
 * true) so users who never click the Terminal tab never pay for a live WS.
 *
 * Protocol:
 *   Server -> client:
 *     - binary: raw tmux pane bytes (ANSI)
 *     - JSON text: { type: "connected", sessionId, streamHandle, initialBuffer }
 *                  { type: "error", message }
 *                  { type: "disconnected" }
 *   Client -> server:
 *     - binary: raw keystrokes
 *     - JSON text: { type: "resize", cols, rows }
 *
 * Reconnect: up to 3 attempts with 1 s backoff before surfacing an error
 * status; the caller renders a Retry button that resets the attempt counter.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type TerminalStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

export interface UseTerminalSocketOptions {
  /** Session id (not tmux name). The server daemon resolves tmux name via the DB. */
  sessionId: string;
  /** Gate on socket lifecycle. Only connects while `enabled` is true. */
  enabled: boolean;
  /** Override the WS base URL. Defaults to `ws(s)://<host>:19400`. */
  wsBaseUrl?: string;
  /** Called on every incoming binary chunk (raw ANSI bytes for xterm.write). */
  onData?: (data: Uint8Array) => void;
  /** Called once when the `connected` envelope arrives, with the pane prepaint. */
  onInitialBuffer?: (buffer: string) => void;
}

export interface UseTerminalSocketResult {
  status: TerminalStatus;
  errorMessage: string | null;
  /** Send raw keystrokes (binary). No-op while not connected. */
  sendInput: (bytes: Uint8Array | string) => void;
  /** Send a resize envelope. No-op while not connected. */
  sendResize: (cols: number, rows: number) => void;
  /** Reset the attempt counter and reconnect. */
  retry: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = 1000;

function defaultWsBase(): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Server daemon runs on port 19400 in local + control-plane profiles. In
  // dev with vite-proxied APIs, callers can override with `wsBaseUrl`.
  return `${proto}//${window.location.hostname}:19400`;
}

export function useTerminalSocket(opts: UseTerminalSocketOptions): UseTerminalSocketResult {
  const { sessionId, enabled, wsBaseUrl, onData, onInitialBuffer } = opts;
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const attemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDataRef = useRef(onData);
  const onInitialBufferRef = useRef(onInitialBuffer);
  const manualCloseRef = useRef(false);
  onDataRef.current = onData;
  onInitialBufferRef.current = onInitialBuffer;

  const closeSocket = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      manualCloseRef.current = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (!enabled || typeof window === "undefined") return;
    manualCloseRef.current = false;
    setStatus("connecting");
    setErrorMessage(null);

    const base = wsBaseUrl ?? defaultWsBase();
    const token = new URLSearchParams(window.location.search).get("token");
    let url = `${base}/terminal/${encodeURIComponent(sessionId)}`;
    if (token) url += `?token=${encodeURIComponent(token)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "WebSocket construction failed");
      return;
    }
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "connected") {
            attemptsRef.current = 0;
            setStatus("connected");
            if (typeof msg.initialBuffer === "string" && msg.initialBuffer.length > 0) {
              onInitialBufferRef.current?.(msg.initialBuffer);
            }
            return;
          }
          if (msg.type === "error") {
            setStatus("error");
            setErrorMessage(typeof msg.message === "string" ? msg.message : "Terminal error");
            return;
          }
          if (msg.type === "disconnected") {
            setStatus("disconnected");
            return;
          }
        } catch {
          // Not JSON -- treat as raw utf-8 output.
          const encoder = new TextEncoder();
          onDataRef.current?.(encoder.encode(event.data));
        }
        return;
      }
      // Binary: raw pane bytes.
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      onDataRef.current?.(bytes);
    };

    ws.onopen = () => {
      // Stay in "connecting" until the server sends the `connected` envelope --
      // that's the signal the tmux attach actually succeeded.
    };

    ws.onerror = () => {
      setStatus("error");
      setErrorMessage((prev) => prev ?? "WebSocket connection failed");
    };

    ws.onclose = () => {
      if (manualCloseRef.current) return;
      if (attemptsRef.current >= MAX_RECONNECT_ATTEMPTS - 1) {
        setStatus("error");
        setErrorMessage((prev) => prev ?? "Disconnected after retries");
        return;
      }
      attemptsRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => connect(), RECONNECT_BACKOFF_MS);
    };
  }, [enabled, sessionId, wsBaseUrl]);

  useEffect(() => {
    if (!enabled) {
      closeSocket();
      setStatus("idle");
      return;
    }
    attemptsRef.current = 0;
    connect();
    return () => {
      closeSocket();
    };
  }, [enabled, connect, closeSocket]);

  const sendInput = useCallback((bytes: Uint8Array | string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (typeof bytes === "string") {
      ws.send(new TextEncoder().encode(bytes));
      return;
    }
    ws.send(bytes);
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }, []);

  const retry = useCallback(() => {
    closeSocket();
    attemptsRef.current = 0;
    connect();
  }, [closeSocket, connect]);

  return { status, errorMessage, sendInput, sendResize, retry };
}
