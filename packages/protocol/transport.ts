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

/**
 * Create a WebSocket client transport that connects to a remote Ark server.
 * Supports optional Bearer token for authentication.
 */
export function createWebSocketTransport(
  url: string,
  opts?: { token?: string; onDisconnect?: () => void },
): { transport: Transport; ready: Promise<void> } {
  const handlers: ((msg: JsonRpcMessage) => void)[] = [];
  let ws: WebSocket;
  let intentionalClose = false;

  // Append token as query param if provided
  const connectUrl = opts?.token
    ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(opts.token)}`
    : url;

  const ready = new Promise<void>((resolve, reject) => {
    ws = new WebSocket(connectUrl);

    ws.onopen = () => resolve();

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
        for (const h of handlers) h(msg);
      } catch { /* ignore malformed messages */ }
    };

    ws.onerror = (_err) => {
      reject(new Error(`WebSocket connection failed: ${connectUrl}`));
    };

    ws.onclose = () => {
      if (!intentionalClose && opts?.onDisconnect) {
        opts.onDisconnect();
      }
    };
  });

  const transport: Transport = {
    send(msg) {
      ws.send(JSON.stringify(msg));
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    close() {
      intentionalClose = true;
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
      // Malformed JSON-RPC message — log and skip
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
      // Stream ended or errored — expected during process exit
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
