import { useState, useEffect } from "react";
import { api } from "./useApi.js";
import { useSse } from "./useSse.js";

export function useSessions() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [groups, setGroups] = useState<string[]>([]);

  useEffect(() => {
    api.getSessions().then(setSessions);
    api.getGroups().then(setGroups);
  }, []);

  const sseData = useSse<any[]>("/api/events/stream");
  useEffect(() => {
    if (!sseData) return;
    setSessions((prev) => {
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
  }, [sseData]);

  async function refresh() {
    const data = await api.getSessions();
    setSessions(data);
  }

  return { sessions, groups, refresh };
}
