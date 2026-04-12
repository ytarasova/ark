import { useState, useEffect } from "react";
import { api } from "./useApi.js";
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
  const [status, setStatus] = useState<DaemonStatus | null>(null);

  const load = () => {
    api.getDaemonStatus()
      .then(setStatus)
      .catch(() => {
        // If the RPC itself fails, the web server is down
        setStatus({
          conductor: { online: false, url: "" },
          arkd: { online: false, url: "" },
          router: { online: false },
        });
      });
  };

  useEffect(() => { load(); }, []);
  useSmartPoll(load, intervalMs);

  return status;
}
