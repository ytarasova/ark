import { useEffect } from "react";
import { useTransport } from "../transport/TransportContext.js";

/**
 * useSseSubscription -- the single SSE primitive every realtime hook in
 * `packages/web/src/hooks/` should compose on top of.
 *
 * Server-Sent Events live wherever the server pushes a snapshot stream
 * (currently `/api/events/stream` for the session list and
 * `/api/sessions/:rootId/tree/stream` for tree views). Both used to roll
 * their own EventSource lifecycle plus heartbeat-tolerant JSON parse;
 * unifying that here gives us:
 *
 *   - one place to add visibility-pause / reconnect-backoff if we ever
 *     want it;
 *   - one place to swallow SSE heartbeats / unrelated event types;
 *   - one cleanup contract (close on unmount or input change).
 *
 * The subscription is enabled-by-default; pass `enabled: false` (or a
 * null/empty `path`) to no-op until inputs land. `eventTypes` defaults to
 * `["message"]` -- the EventSource default channel; named events on the
 * stream require explicit listeners.
 *
 * `onPayload` receives the parsed JSON payload (any). The hook holds no
 * state of its own -- callers either set component state, push into the
 * react-query cache via `queryClient.setQueryData`, or both.
 */
export function useSseSubscription(opts: {
  path: string | null | undefined;
  eventTypes?: string[];
  enabled?: boolean;
  onPayload: (payload: unknown) => void;
}): void {
  const { path, eventTypes, enabled, onPayload } = opts;
  const transport = useTransport();

  useEffect(() => {
    if (!path || enabled === false) return;
    const source = transport.createEventSource(path);
    const handle = (e: MessageEvent) => {
      try {
        onPayload(JSON.parse(e.data));
      } catch {
        // SSE heartbeats and unrelated event types arrive as non-JSON or
        // empty payloads. Ignored by design; the next valid frame will
        // call `onPayload` again.
      }
    };
    const types = eventTypes && eventTypes.length > 0 ? eventTypes : ["message"];
    for (const type of types) {
      source.addEventListener(type, handle as EventListener);
    }
    source.onerror = () => {
      /* the browser auto-reconnects EventSource on transient errors */
    };
    return () => source.close();
    // `eventTypes` is read once per effect run; callers should pass a stable
    // reference (literal array or memoised value) to avoid resubscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, transport, onPayload, eventTypes?.join("|")]);
}
