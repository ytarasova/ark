import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

/**
 * Dashboard summary + running sessions. Refetched every 5s -- matches the
 * legacy smart-poll cadence. TanStack Query handles the visibility pause
 * via `refetchIntervalInBackground: false` (default).
 */
export function useDashboardSummaryQuery() {
  const api = useApi();
  return useQuery({
    queryKey: ["dashboard", "summary"],
    queryFn: api.getDashboardSummary,
    refetchInterval: 5000,
  });
}

export function useRunningSessionsQuery() {
  const api = useApi();
  return useQuery({
    queryKey: ["sessions", "running"],
    queryFn: () => api.getSessions({}),
    refetchInterval: 5000,
  });
}
