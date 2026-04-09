import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSessionsQuery, useGroupsQuery } from "./useSessionQueries.js";
import { useSse } from "./useSse.js";

export function useSessions() {
  const queryClient = useQueryClient();
  const { data: sessions = [], refetch } = useSessionsQuery();
  const { data: groups = [] } = useGroupsQuery();

  const sseData = useSse<any[]>("/api/events/stream");

  useEffect(() => {
    if (!sseData) return;
    queryClient.setQueryData<any[]>(["sessions"], (prev) => {
      if (!prev) return prev;
      const map = new Map(prev.map((s) => [s.id, s]));
      for (const u of sseData) {
        const existing = map.get(u.id);
        if (existing) {
          map.set(u.id, { ...existing, status: u.status, summary: u.summary, agent: u.agent, repo: u.repo, group_name: u.group, updated_at: u.updated });
        } else {
          map.set(u.id, { id: u.id, status: u.status, summary: u.summary, agent: u.agent, repo: u.repo, group_name: u.group, updated_at: u.updated });
        }
      }
      return Array.from(map.values());
    });
  }, [sseData, queryClient]);

  return { sessions, groups, refresh: refetch };
}
