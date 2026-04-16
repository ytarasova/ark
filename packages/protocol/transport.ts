import type { JsonRpcMessage } from "./types.js";

export const JsonlCodec = {
  encode(msg: JsonRpcMessage): string {
    return JSON.stringify(msg) + "\n";
  },

  decode(line: string): JsonRpcMessage {
    return JSON.parse(line.trimEnd());
  },

  createLineSplitter(onLine: (line: string) => void) {
    let buffer = "";
    return {
      push(chunk: string) {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (line.trim()) onLine(line);
        }
      },
      flush() {
        if (buffer.trim()) onLine(buffer);
        buffer = "";
      },
    };
  },
};

export interface Transport {
  send(msg: JsonRpcMessage): void;
  onMessage(handler: (msg: JsonRpcMessage) => void): void;
  close(): void;
}

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

export interface WebSocketTransportOptions {
  token?: string;
  reconnect?: boolean;
  maxReconnectDelay?: number;
  onStatus?: (status: ConnectionStatus) => void;
}

/**
 * Create a WebSocket client transport that connects to a remote Ark server.
 * Supports optional Bearer token for authentication and automatic reconnection.
 */
export function createWebSocketTransport(
  url: string,
  opts?: WebSocketTransportOptions,
): { transport: Transport; ready: Promise<void> } {
  const handlers: ((msg: JsonRpcMessage) => void)[] = [];
  const reconnect = opts?.reconnect ?? false;
  const maxDelay = opts?.maxReconnectDelay ?? 30000;
  const onStatus = opts?.onStatus;

  let ws: WebSocket;
  let closed = false;
  let buffer: JsonRpcMessage[] = [];
  const MAX_BUFFER = 100;

  // Append token as query param if provided
  const connectUrl = opts?.token
    ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(opts.token)}`
    : url;

  function wireWs(socket: WebSocket) {
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
        for (const h of handlers) h(msg);
      } catch { /* ignore malformed messages */ }
    };

    socket.onclose = () => {
      if (closed || !reconnect) return;
      onStatus?.("reconnecting");
      startReconnect();
    };

    socket.onerror = () => {
      // onerror is always followed by onclose for WebSocket, so reconnect fires there
    };
  }

  function startReconnect() {
    let delay = 1000;
    const attempt = () => {
      if (closed) return;
      try {
        const next = new WebSocket(connectUrl);
        next.onopen = () => {
          ws = next;
          wireWs(ws);
          onStatus?.("connected");
          // Flush buffered messages
          const pending = buffer;
          buffer = [];
          for (const msg of pending) {
            try { ws.send(JSON.stringify(msg)); } catch { /* drop if send fails */ }
          }
        };
        next.onerror = () => {
          // Retry with backoff
          delay = Math.min(delay * 2, maxDelay);
          setTimeout(attempt, delay);
        };
      } catch {
        delay = Math.min(delay * 2, maxDelay);
        setTimeout(attempt, delay);
      }
    };
    setTimeout(attempt, delay);
  }

  const ready = new Promise<void>((resolve, reject) => {
    ws = new WebSocket(connectUrl);

    ws.onopen = () => {
      wireWs(ws);
      onStatus?.("connected");
      resolve();
    };

    ws.onerror = (_err) => {
      reject(new Error(`WebSocket connection failed: ${connectUrl}`));
    };
  });

  const transport: Transport = {
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      } else if (reconnect && !closed) {
        // Buffer during reconnect
        buffer.push(msg);
        if (buffer.length > MAX_BUFFER) buffer.shift();
      }
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    close() {
      closed = true;
      ws.close();
    },
  };

  return { transport, ready };
}

export function createStdioTransport(
  input: ReadableStream<Uint8Array>,
  output: { write(data: string): void },
): Transport {
  const handlers: ((msg: JsonRpcMessage) => void)[] = [];
  const decoder = new TextDecoder();
  const splitter = JsonlCodec.createLineSplitter((line) => {
    try {
      const msg = JsonlCodec.decode(line);
      for (const h of handlers) h(msg);
    } catch (err) {
      // Malformed JSON-RPC message -- log and skip
      if (process.env.ARK_DEBUG) console.error("[transport] parse error:", err);
    }
  });

  const reader = input.getReader();
  let closed = false;
  (async () => {
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        splitter.push(decoder.decode(value));
      }
    } catch (err) {
      // Stream ended or errored -- expected during process exit
      if (process.env.ARK_DEBUG) console.error("[transport] stream error:", err);
    }
    splitter.flush();
  })();

  return {
    send(msg: JsonRpcMessage) {
      output.write(JsonlCodec.encode(msg));
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    close() {
      closed = true;
    },
  };
}
