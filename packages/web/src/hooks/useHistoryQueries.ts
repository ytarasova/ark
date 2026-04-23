import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

/** Recent Ark sessions (newest first). Derived from the main `sessions` query. */
export function useRecentSessionsQuery() {
  const api = useApi();
  return useQuery({
    queryKey: ["sessions", "recent"],
    queryFn: async () => {
      const sessions = await api.getSessions();
      return (sessions || [])
        .slice()
        .sort((a: any, b: any) => {
          const da = new Date(a.updated_at || 0).getTime();
          const db = new Date(b.updated_at || 0).getTime();
          return db - da;
        })
        .slice(0, 20);
    },
  });
}

/** Claude Code transcripts (history.list). */
export function useClaudeSessionsQuery() {
  const api = useApi();
  return useQuery({
    queryKey: ["history", "claude-sessions"],
    queryFn: () => api.getClaudeSessions().then((items) => (Array.isArray(items) ? items : [])),
  });
}

/** Refresh-and-index mutation. Invalidates the transcripts list on success. */
export function useRefreshHistoryMutation() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshHistory(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["history", "claude-sessions"] }),
  });
}
