import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSessionsQuery, useGroupsQuery } from "./useSessionQueries.js";
import { useSseSubscription } from "./useSseSubscription.js";

/**
 * Realtime-aware session list. TanStack Query owns the snapshot (5s poll),
 * SSE pushes the same shape on `/api/events/stream`'s `sessions` event and
 * gets merged into the same query cache so the UI never flickers between a
 * stale poll result and a live push.
 *
 * Archived view skips the SSE merge -- archived rows don't change in
 * realtime and merging would resurrect them in the active view's cache.
 */
export function useSessions(serverStatus?: string, opts?: { rootsOnly?: boolean }) {
  const rootsOnly = opts?.rootsOnly ?? false;
  const queryClient = useQueryClient();
  const { data: sessions = [], refetch } = useSessionsQuery(serverStatus, { rootsOnly });
  const { data: groups = [] } = useGroupsQuery();

  const onSessionsPush = useCallback(
    (raw: unknown) => {
      if (serverStatus === "archived") return;
      if (!Array.isArray(raw)) return;
      const queryKey = ["sessions", serverStatus || "default", rootsOnly ? "roots" : "flat"];
      queryClient.setQueryData<any[]>(queryKey, (prev) => {
        if (!prev) return prev;
        const map = new Map(prev.map((s) => [s.id, s]));
        for (const u of raw) {
          if (!u || typeof u !== "object" || typeof u.id !== "string") continue;
          const existing = map.get(u.id);
          map.set(u.id, {
            ...(existing ?? { id: u.id }),
            status: u.status,
            summary: u.summary,
            agent: u.agent,
            repo: u.repo,
            group_name: u.group,
            updated_at: u.updated,
          });
        }
        return Array.from(map.values());
      });
    },
    [queryClient, serverStatus, rootsOnly],
  );

  useSseSubscription({
    path: "/api/events/stream",
    eventTypes: ["sessions"],
    onPayload: onSessionsPush,
  });

  return { sessions, groups, refresh: refetch };
}
