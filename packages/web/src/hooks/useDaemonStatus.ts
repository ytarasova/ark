import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export interface DaemonStatus {
  conductor: { online: boolean; url: string };
  arkd: { online: boolean; url: string };
  router: { online: boolean };
}

const OFFLINE_FALLBACK: DaemonStatus = {
  conductor: { online: false, url: "" },
  arkd: { online: false, url: "" },
  router: { online: false },
};

/**
 * Polls daemon/status to detect whether conductor and arkd are reachable.
 * Returns null while the first request is in flight, then the latest status.
 *
 * Polling cadence default 15s, paused automatically when the tab is hidden
 * (TanStack Query default `refetchIntervalInBackground: false`). On RPC
 * failure -- which means the web server itself is down -- the hook resolves
 * to an "all-offline" snapshot rather than throwing.
 */
export function useDaemonStatus(intervalMs = 15000): DaemonStatus | null {
  const api = useApi();
  const { data } = useQuery({
    queryKey: ["daemon-status"],
    queryFn: () => api.getDaemonStatus().catch(() => OFFLINE_FALLBACK),
    refetchInterval: intervalMs,
    staleTime: 0,
  });
  return data ?? null;
}
