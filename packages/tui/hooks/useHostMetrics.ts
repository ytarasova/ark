import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { getProvider } from "../../compute/index.js";
import type { Host } from "../../core/index.js";
import type { HostSnapshot } from "../../compute/types.js";

export function useHostMetrics(hosts: Host[], active: boolean, pollMs = 10000) {
  const [logs, setLogs] = useState<Map<string, string[]>>(new Map());

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

  const runningHosts = active ? hosts.filter(h => h.status === "running") : [];

  const results = useQueries({
    queries: runningHosts.map((h) => ({
      queryKey: ["hostMetrics", h.name],
      queryFn: async (): Promise<HostSnapshot | null> => {
        const provider = getProvider(h.provider);
        if (!provider) return null;
        try {
          return await provider.getMetrics(h);
        } catch {
          return null;
        }
      },
      refetchInterval: pollMs,
      staleTime: pollMs - 1000,
      placeholderData: (prev: HostSnapshot | null | undefined) => prev ?? undefined,
      enabled: active,
    })),
  });

  const snapshots = new Map<string, HostSnapshot>();
  results.forEach((result, i) => {
    if (result.data) {
      snapshots.set(runningHosts[i].name, result.data);
    }
  });

  const fetching = results.some(r => r.isFetching);

  return { snapshots, logs, addLog, fetching };
}
