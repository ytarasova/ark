import { useState, useEffect, useCallback } from "react";
import { useApi } from "./useApi.js";
import { useSmartPoll } from "./useSmartPoll.js";

/** Stable failure category surfaced by `daemon/status`. */
export type ReachabilityReason = "connection-refused" | "timeout" | "http-error" | "unknown";

/**
 * Per-service reachability report. `online` / `url` are always present;
 * when the probe failed, `reason` categorises the failure and `message`
 * carries the human-readable detail (e.g. "connection refused",
 * "/health returned HTTP 503"). `latencyMs` is the time the probe took
 * -- surface it in debug overlays but not in the main status dot.
 */
export interface Reachability {
  online: boolean;
  url: string;
  latencyMs?: number;
  reason?: ReachabilityReason;
  message?: string;
  httpStatus?: number;
}

export interface DaemonStatus {
  conductor: Reachability;
  arkd: Reachability;
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
      .catch((err: unknown) => {
        // If the RPC itself fails, the web server is down. Treat that as
        // an unknown-cause offline for both services so the UI can render
        // the same diagnostic path it uses for a failed /health probe.
        const message = err instanceof Error ? err.message : String(err ?? "RPC call failed");
        setStatus({
          conductor: { online: false, url: "", reason: "unknown", message },
          arkd: { online: false, url: "", reason: "unknown", message },
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
