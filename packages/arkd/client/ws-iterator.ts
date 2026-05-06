import { ArkdClientError } from "../common/errors.js";

/**
 * Bridge a WebSocket to an `AsyncIterable<E>`, resolving only after the
 * server sends `{ type: "subscribed" }` as its first frame.
 *
 * Why wait for the ack rather than the client-side `open` event:
 * The client's `open` event fires when the HTTP Upgrade response arrives.
 * Bun's server-side `ws.open()` callback -- where `s.subscribers.add(ws)`
 * is called -- runs separately and may complete after the client's `open`
 * handler. If a publish races in between, it finds no subscriber and
 * buffers instead of delivering directly.
 *
 * The ack (`SUBSCRIBED_ACK`) is sent from the very end of the server's
 * `open()` handler, after the subscriber has been registered and the ring
 * has been drained. Receiving it is a proof that the server-side state
 * is consistent: any publish that happens after this point is guaranteed
 * to find a live subscriber.
 *
 * Envelope frames (all frames except the ack control frame) are queued and
 * yielded to the caller in arrival order. A WS `error` event surfaces as
 * an `ArkdClientError` thrown out of the iterator.
 */
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
      // The ack is a control frame; strip it before yielding to callers.
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

  // Block until the server confirms the subscriber is registered and any
  // buffered ring entries have been drained. Rejects on error, close, or
  // abort so callers see a clean failure rather than hanging forever.
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
