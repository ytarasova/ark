/**
 * Push-based store — replaces useStore polling with ArkClient notifications.
 *
 * On mount: fetches initial sessions, computes, agents, flows via RPC.
 * On notification: merges updates into local state.
 * Exposes the same StoreData interface for backward compatibility.
 *
 * Key improvements over useStore:
 *   - session/* notifications → immediate UI update (no 3s polling lag)
 *   - Fallback refresh every 30s (vs 3s) — much less DB churn
 *   - Metrics fetched every 30s (same cadence as full refresh)
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useArkClient } from "./useArkClient.js";
import type { ComputeSnapshot } from "../../compute/types.js";

export interface StoreData {
  sessions: any[];
  computes: any[];
  agents: any[];
  flows: any[];
  /** Unread message counts per session ID. */
  unreadCounts: Map<string, number>;
  /** Compute metrics snapshots by compute name. */
  snapshots: Map<string, ComputeSnapshot>;
  /** Activity logs per compute name. */
  computeLogs: Map<string, string[]>;
  /** Add a log entry for a compute. */
  addComputeLog: (name: string, message: string) => void;
  refreshing: boolean;
  /** True until the first data fetch completes. */
  initialLoading: boolean;
  /** Force an immediate refresh (call after mutations like delete/stop). */
  refresh: () => void;
}

export function useArkStore(): StoreData {
  const ark = useArkClient();

  const [sessions, setSessions] = useState<any[]>([]);
  const [computes, setComputes] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [flows, setFlows] = useState<any[]>([]);
  const [unreadCounts, setUnreadCounts] = useState<Map<string, number>>(new Map());
  const [snapshots, setSnapshots] = useState<Map<string, ComputeSnapshot>>(new Map());
  const [computeLogs, setComputeLogs] = useState<Map<string, string[]>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Track in-flight fetch to avoid overlapping refreshes
  const running = useRef(false);

  // ── Core fetch ──────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setRefreshing(true);
    try {
      const [s, c, a, f] = await Promise.all([
        ark.sessionList(),
        ark.computeList(),
        ark.agentList(),
        ark.flowList(),
      ]);
      setSessions(s);
      setComputes(c);
      setAgents(a);
      setFlows(f);

      // Unread counts — batch over sessions
      const counts = new Map<string, number>();
      await Promise.all(
        s.map(async (session: any) => {
          try {
            const msgs = await ark.sessionMessages(session.id, 100);
            const unread = msgs.filter((m: any) => !m.read && m.role !== "user").length;
            if (unread > 0) counts.set(session.id, unread);
          } catch {
            // Non-fatal: skip unread count for this session
          }
        })
      );
      setUnreadCounts(counts);

      // Metrics — fetch for every running compute
      const next = new Map<string, ComputeSnapshot>();
      await Promise.all(
        c
          .filter((comp: any) => comp.status === "running")
          .map(async (comp: any) => {
            try {
              const snap = await ark.metricsSnapshot(comp.name);
              if (snap) next.set(comp.name, snap);
            } catch {
              // Non-fatal: skip metrics for this compute
            }
          })
      );
      setSnapshots(next);

      setInitialLoading(false);
    } catch {
      // Non-fatal: leave stale data in place
    }
    setRefreshing(false);
    running.current = false;
  }, [ark]);

  // ── Initial fetch ───────────────────────────────────────────────────────────

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ── Notification subscriptions — real-time session updates ─────────────────

  useEffect(() => {
    const handleUpdated = (data: any) => {
      if (data.session) {
        setSessions(prev => {
          const idx = prev.findIndex(s => s.id === data.session.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...data.session };
            return next;
          }
          return prev;
        });
      }
    };

    const handleCreated = (data: any) => {
      if (data.session) {
        setSessions(prev => [data.session, ...prev]);
      }
    };

    const handleDeleted = (data: any) => {
      if (data.sessionId) {
        setSessions(prev => prev.filter(s => s.id !== data.sessionId));
      }
    };

    ark.on("session/updated", handleUpdated);
    ark.on("session/created", handleCreated);
    ark.on("session/deleted", handleDeleted);

    return () => {
      ark.off("session/updated", handleUpdated);
      ark.off("session/created", handleCreated);
      ark.off("session/deleted", handleDeleted);
    };
  }, [ark]);

  // ── Periodic fallback refresh (30s) ─────────────────────────────────────────

  useEffect(() => {
    const t = setInterval(fetchAll, 30_000);
    return () => clearInterval(t);
  }, [fetchAll]);

  // ── addComputeLog ───────────────────────────────────────────────────────────

  const addComputeLog = useCallback((name: string, message: string) => {
    setComputeLogs(prev => {
      const entries = [...(prev.get(name) ?? [])];
      const ts = new Date().toISOString().slice(11, 19);
      entries.push(`${ts}  ${message}`);
      if (entries.length > 50) entries.splice(0, entries.length - 50);
      const next = new Map(prev);
      next.set(name, entries);
      return next;
    });
  }, []);

  return {
    sessions,
    computes,
    agents,
    flows,
    unreadCounts,
    snapshots,
    computeLogs,
    addComputeLog,
    refreshing,
    initialLoading,
    refresh: fetchAll,
  };
}
