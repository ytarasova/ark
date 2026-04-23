import { useState, useEffect, useCallback } from "react";
import { useApi } from "./useApi.js";
import { useSmartPoll } from "./useSmartPoll.js";

export interface DaemonStatus {
  conductor: { online: boolean; url: string };
  arkd: { online: boolean; url: string };
  router: { online: boolean };
}

/**
 * Polls daemon/status to detect whether conductor and arkd are reachable.
 * Returns null while loading, then the latest status.
 */
export function useDaemonStatus(intervalMs = 15000): DaemonStatus | null {
  const api = useApi();
  const [status, setStatus] = useState<DaemonStatus | null>(null);

  const load = useCallback(() => {
    api
      .getDaemonStatus()
      .then(setStatus)
      .catch(() => {
        // If the RPC itself fails, the web server is down
        setStatus({
          conductor: { online: false, url: "" },
          arkd: { online: false, url: "" },
          router: { online: false },
        });
      });
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);
  useSmartPoll(load, intervalMs);

  return status;
}
