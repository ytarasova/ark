import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSseSubscription } from "./useSseSubscription.js";

/**
 * Subscribe to `/api/sessions/:rootId/tree/stream` and push updates into the
 * react-query cache at `["session-tree", rootId]`. The server debounces its
 * SSE emissions to 200ms so no extra client throttling is needed.
 *
 * The server emits `tree` events carrying `{ root: SessionWithChildren }`,
 * but some deployments send the same payload on the default `message`
 * channel. Listening on both keeps the hook resilient to the envelope
 * choice.
 */
export function useSessionTreeStream(rootId: string | null, enabled: boolean = true): void {
  const qc = useQueryClient();

  const onPayload = useCallback(
    (payload: unknown) => {
      if (!rootId) return;
      const root = (payload as { root?: unknown })?.root ?? payload;
      if (root && typeof root === "object" && typeof (root as { id?: unknown }).id === "string") {
        qc.setQueryData(["session-tree", rootId], root);
      }
    },
    [rootId, qc],
  );

  useSseSubscription({
    path: rootId ? `/api/sessions/${rootId}/tree/stream` : null,
    eventTypes: ["tree", "message"],
    enabled: enabled && !!rootId,
    onPayload,
  });
}
