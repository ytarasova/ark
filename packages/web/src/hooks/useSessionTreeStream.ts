import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTransport } from "../transport/TransportContext.js";

/**
 * Subscribe to live session tree snapshots via the JSON-RPC WebSocket and
 * push updates into the react-query cache at `["session-tree", rootId]`.
 *
 * Replaces the previous SSE-based consumer of
 * `/api/sessions/:rootId/tree/stream`. The server debounces its push
 * notifications to 200ms so no extra client-side throttling is needed.
 *
 * Uses `transport.sessionTreeStream()` which opens a WebSocket to the server
 * daemon, calls `session/tree-stream` to receive an initial snapshot, then
 * listens for `session/tree-update` notifications for subsequent changes.
 */
export function useSessionTreeStream(rootId: string | null, enabled: boolean = true): void {
  const qc = useQueryClient();
  const transport = useTransport();
  // Keep a stable ref to the latest qc so the callback below never goes stale.
  const qcRef = useRef(qc);
  qcRef.current = qc;

  useEffect(() => {
    if (!rootId || !enabled) return;

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const applyRoot = (root: unknown) => {
      if (cancelled || !rootId) return;
      if (root && typeof root === "object" && typeof (root as { id?: unknown }).id === "string") {
        qcRef.current.setQueryData(["session-tree", rootId], root);
      }
    };

    transport
      .sessionTreeStream(rootId, (root) => {
        applyRoot(root);
      })
      .then(({ tree, unsubscribe: u }) => {
        if (cancelled) {
          u();
          return;
        }
        // Apply the initial snapshot returned with the subscription response.
        applyRoot(tree);
        unsubscribe = u;
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("useSessionTreeStream: sessionTreeStream failed", err);
        }
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [rootId, enabled, transport]);
}
