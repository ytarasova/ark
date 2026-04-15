import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSessionsQuery, useGroupsQuery } from "./useSessionQueries.js";
import { useSse } from "./useSse.js";

export function useSessions(serverStatus?: string) {
  const queryClient = useQueryClient();
  const { data: sessions = [], refetch } = useSessionsQuery(serverStatus);
  const { data: groups = [] } = useGroupsQuery();

  const sseData = useSse<any[]>("/api/events/stream");

  useEffect(() => {
    if (!sseData) return;
    // Skip SSE merges for archived view -- archived sessions don't change in real-time
    if (serverStatus === "archived") return;
    const queryKey = ["sessions", serverStatus || "default"];
    queryClient.setQueryData<any[]>(queryKey, (prev) => {
      if (!prev) return prev;
      const map = new Map(prev.map((s) => [s.id, s]));
      for (const u of sseData) {
        const existing = map.get(u.id);
        if (existing) {
          map.set(u.id, {
            ...existing,
            status: u.status,
            summary: u.summary,
            agent: u.agent,
            repo: u.repo,
            group_name: u.group,
            updated_at: u.updated,
          });
        } else {
          map.set(u.id, {
            id: u.id,
            status: u.status,
            summary: u.summary,
            agent: u.agent,
            repo: u.repo,
            group_name: u.group,
            updated_at: u.updated,
          });
        }
      }
      return Array.from(map.values());
    });
  }, [sseData, queryClient, serverStatus]);

  return { sessions, groups, refresh: refetch };
}
