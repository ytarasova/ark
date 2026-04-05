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
    } catch {}
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
    } catch {}
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
