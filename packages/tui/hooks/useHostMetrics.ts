import { useState, useEffect, useRef } from "react";
import { getProvider } from "../../compute/index.js";
import type { HostSnapshot } from "../../compute/types.js";
import type { Host } from "../../core/index.js";

export function useHostMetrics(hosts: Host[], active: boolean, refreshMs = 10000) {
  const [snapshots, setSnapshots] = useState<Map<string, HostSnapshot>>(new Map());
  const [logs, setLogs] = useState<Map<string, string[]>>(new Map());
  const [fetching, setFetching] = useState(false);
  const polling = useRef(false);

  const addLog = (hostName: string, message: string) => {
    setLogs((prev) => {
      const next = new Map(prev);
      const entries = [...(next.get(hostName) ?? [])];
      const ts = new Date().toISOString().slice(11, 19);
      entries.push(`${ts}  ${message}`);
      if (entries.length > 50) entries.splice(0, entries.length - 50);
      next.set(hostName, entries);
      return next;
    });
  };

  useEffect(() => {
    if (!active) return;

    const refresh = async () => {
      if (polling.current) return;
      polling.current = true;
      setFetching(true);
      try {
        const next = new Map(snapshots);
        for (const h of hosts) {
          if (h.status !== "running") continue;
          const provider = getProvider(h.provider);
          if (!provider) continue;
          try {
            const snap = await provider.getMetrics(h);
            next.set(h.name, snap);
          } catch {
            // skip
          }
        }
        // Prune stale entries
        const hostNames = new Set(hosts.map((h) => h.name));
        for (const key of next.keys()) {
          if (!hostNames.has(key)) next.delete(key);
        }
        setSnapshots(next);
      } finally {
        polling.current = false;
        setFetching(false);
      }
    };

    refresh();
    const t = setInterval(refresh, refreshMs);
    return () => clearInterval(t);
  }, [active, hosts.length, refreshMs]);

  return { snapshots, logs, addLog, fetching };
}
