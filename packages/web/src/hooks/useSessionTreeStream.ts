import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTransport } from "../transport/TransportContext.js";

/**
 * Subscribe to `/api/sessions/:rootId/tree/stream` and push updates into the
 * react-query cache at `["session-tree", rootId]`. The server debounces its
 * SSE emissions to 200ms so no extra client throttling is needed.
 *
 * Emits `tree` events carrying the full `{ root }` snapshot. Silently ignores
 * malformed payloads (heartbeats, etc). Closes the EventSource on unmount or
 * when `rootId` changes.
 */
export function useSessionTreeStream(rootId: string | null, enabled: boolean = true): void {
  const transport = useTransport();
  const qc = useQueryClient();

  useEffect(() => {
    if (!rootId || !enabled) return;
    const source = transport.createEventSource(`/api/sessions/${rootId}/tree/stream`);

    const handle = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        // Server contract: `{ root: SessionWithChildren }` or the bare root
        // object. Accept both so we don't couple to the exact envelope.
        const root = payload?.root ?? payload;
        if (root && typeof root === "object" && typeof root.id === "string") {
          qc.setQueryData(["session-tree", rootId], root);
        }
      } catch {
        // Non-JSON heartbeat or unrelated event type -- ignore.
      }
    };

    source.addEventListener("tree", handle as EventListener);
    // Some servers emit on the default `message` channel; subscribe to both.
    source.addEventListener("message", handle as EventListener);
    source.onerror = () => {
      /* browser auto-reconnects */
    };
    return () => source.close();
  }, [rootId, enabled, transport, qc]);
}
