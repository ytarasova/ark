import { useState, useEffect, useRef, useCallback } from "react";
import { getProvider } from "../../compute/index.js";
import type { Host } from "../../core/index.js";
import type { HostSnapshot } from "../../compute/types.js";

export function useHostMetrics(hosts: Host[], active: boolean, pollMs = 10000) {
  const [snapshots, setSnapshots] = useState<Map<string, HostSnapshot>>(new Map());
  const [logs, setLogs] = useState<Map<string, string[]>>(new Map());
  const [fetching, setFetching] = useState(false);
  const running = useRef(false);

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

  const refresh = useCallback(async () => {
    if (running.current || !active) return;
    const runningHosts = hosts.filter(h => h.status === "running");
    if (runningHosts.length === 0) return;

    running.current = true;
    setFetching(true);
    const next = new Map<string, HostSnapshot>();
    for (const h of runningHosts) {
      const provider = getProvider(h.provider);
      if (!provider) continue;
      try {
        const snap = await provider.getMetrics(h);
        if (snap) next.set(h.name, snap);
      } catch {}
    }
    setSnapshots(next);
    running.current = false;
    setFetching(false);
  }, [hosts, active]);

  useEffect(() => {
    if (!active) return;
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, active, pollMs]);

  return { snapshots, logs, addLog, fetching };
}
