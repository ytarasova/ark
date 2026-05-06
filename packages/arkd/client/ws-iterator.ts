/**
 * Bridge a WebSocket subscription to an `AsyncIterable<E>`.
 *
 * Resolves only after the server sends `{ type: "subscribed" }` as its
 * first frame -- the client's `open` event fires when the HTTP Upgrade
 * response arrives, but Bun's server-side `ws.open()` callback may run
 * later. The ack proves the subscriber is registered, so any publish
 * after `await subscribeToChannel(...)` is guaranteed to find a live
 * subscriber rather than buffer.
 */

import { ArkdClientError } from "../common/errors.js";

export async function webSocketToAsyncIterable<E extends Record<string, unknown>>(
  ws: WebSocket,
  channel: string,
  signal: AbortSignal | undefined,
): Promise<AsyncIterable<E>> {
  const queue: E[] = [];
  let resume: (() => void) | null = null;
  let closed = false;
  let error: Error | null = null;

  const wake = (): void => {
    const r = resume;
    resume = null;
    if (r) r();
  };

  let resolveAck!: () => void;
  let rejectAck!: (err: Error) => void;
  const ackPromise = new Promise<void>((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
  });

  ws.addEventListener("message", (ev) => {
    try {
      const data = typeof ev.data === "string" ? ev.data : "";
      if (!data) return;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed.type === "subscribed") {
        resolveAck();
        return;
      }
      queue.push(parsed as E);
      wake();
    } catch {
      /* malformed frame -- skip rather than crash the consumer loop */
    }
  });

  ws.addEventListener("close", () => {
    closed = true;
    rejectAck(new ArkdClientError(`channel ws closed before subscribed ack: ${channel}`));
    wake();
  });

  ws.addEventListener("error", () => {
    error = new ArkdClientError(`channel ws subscribe failed: ${channel}`);
    closed = true;
    rejectAck(error);
    wake();
  });

  const abort = (): void => {
    closed = true;
    rejectAck(new ArkdClientError(`channel ws subscribe aborted: ${channel}`));
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    wake();
  };

  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  await ackPromise;

  return {
    [Symbol.asyncIterator](): AsyncIterator<E> {
      return {
        async next(): Promise<IteratorResult<E>> {
          while (true) {
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }
            if (closed) {
              if (error) throw error;
              try {
                ws.close();
              } catch {
                /* already closed */
              }
              return { value: undefined as unknown as E, done: true };
            }
            await new Promise<void>((resolve) => {
              resume = resolve;
            });
          }
        },
        async return(): Promise<IteratorResult<E>> {
          closed = true;
          try {
            ws.close();
          } catch {
            /* already closed */
          }
          wake();
          return { value: undefined as unknown as E, done: true };
        },
      };
    },
  };
}
