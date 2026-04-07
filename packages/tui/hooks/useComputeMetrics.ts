import { useState, useEffect, useRef } from "react";
import { getProvider } from "../../compute/index.js";
import { getApp } from "../../core/app.js";
import type { Compute } from "../../types/index.js";
import type { ComputeSnapshot } from "../../compute/types.js";

export function useComputeMetrics(computes: Compute[], active: boolean, pollMs = 10000) {
  const [snapshots, setSnapshots] = useState<Map<string, ComputeSnapshot>>(new Map());
  const [logs, setLogs] = useState<Map<string, string[]>>(new Map());
  const [fetching, setFetching] = useState(false);
  const running = useRef(false);
  const computesRef = useRef(computes);
  computesRef.current = computes;

  const addLog = (computeName: string, message: string) => {
    setLogs((prev) => {
      const next = new Map(prev);
      const entries = [...(next.get(computeName) ?? [])];
      const ts = new Date().toISOString().slice(11, 19);
      entries.push(`${ts}  ${message}`);
      if (entries.length > 50) entries.splice(0, entries.length - 50);
      next.set(computeName, entries);
      return next;
    });
  };

  useEffect(() => {
    if (!active) return;

    const refresh = async () => {
      if (running.current) return;
      const runningComputes = computesRef.current.filter(h => h.status === "running");
      if (runningComputes.length === 0) return;

      running.current = true;
      setFetching(true);
      const next = new Map<string, ComputeSnapshot>();
      for (const h of runningComputes) {
        const provider = getProvider(h.provider);
        if (!provider) continue;
        try {
          const snap = await provider.getMetrics(h);
          if (snap) next.set(h.name, snap);
        } catch {
          // Metrics failed — check if the instance still exists
          if (provider.checkStatus) {
            try {
              const realStatus = await provider.checkStatus(h);
              if (realStatus && realStatus !== h.status) {
                getApp().computes.update(h.name, { status: realStatus as import("../../types/index.js").ComputeStatus });
                if (realStatus === "destroyed") {
                  getApp().computes.mergeConfig(h.name, { ip: null });
                  addLog(h.name, "Instance no longer exists — marked as destroyed");
                } else {
                  addLog(h.name, `Status changed: ${h.status} → ${realStatus}`);
                }
              }
            } catch { /* checkStatus itself failed, skip */ }
          }
        }
      }
      setSnapshots(next);
      running.current = false;
      setFetching(false);
    };

    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [active, pollMs]);

  return { snapshots, logs, addLog, fetching };
}
