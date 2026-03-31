import { useState, useEffect, useRef, useCallback } from "react";
import * as core from "../../core/index.js";
import { getProvider } from "../../compute/index.js";
import type { ComputeSnapshot } from "../../compute/types.js";

export interface StoreData {
  sessions: core.Session[];
  computes: core.Compute[];
  agents: ReturnType<typeof core.listAgents>;
  flows: ReturnType<typeof core.listFlows>;
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

/**
 * Reconcile DB sessions with tmux reality.
 * Only checks for dead tmux sessions — status detection is handled by hooks
 * (SessionStart→running, Stop→ready, StopFailure→failed, Notification→waiting).
 */
async function reconcileSessions(sessions: core.Session[]): Promise<void> {
  for (const s of sessions) {
    if (s.status !== "running" || !s.session_id) continue;

    const computeName = s.compute_name ?? "local";
    const compute = core.getCompute(computeName);
    if (!compute) continue;
    const provider = getProvider(compute.provider);
    if (!provider) continue;
    const exists = await provider.checkSession(compute, s.session_id);

    if (!exists) {
      // Tmux session is gone — agent crashed or exited without hook firing
      core.updateSession(s.id, { status: "failed", error: "Agent process exited", session_id: null });
      core.logEvent(s.id, "agent_exited", {
        stage: s.stage ?? undefined,
        actor: "system",
      });
      s.status = "failed";
      s.error = "Agent process exited";
      s.session_id = null;
    }
  }
}

type Payload = Omit<StoreData, "refreshing" | "refresh" | "addComputeLog">;

/** Fetch all store data in one shot. */
async function fetchAll(prev: Payload, metricsThisCycle: boolean): Promise<Payload> {
  const sessions = core.listSessions({ limit: 50 });
  await reconcileSessions(sessions);
  const computes = core.listCompute();

  // Batch unread counts
  const unreadCounts = new Map<string, number>();
  for (const s of sessions) {
    const count = core.getUnreadCount(s.id);
    if (count > 0) unreadCounts.set(s.id, count);
  }

  // Metrics — only fetch every few cycles (expensive)
  let snapshots = prev.snapshots;
  if (metricsThisCycle) {
    const next = new Map<string, ComputeSnapshot>();
    for (const c of computes) {
      if (c.status !== "running") continue;
      const provider = getProvider(c.provider);
      if (!provider) continue;
      try {
        const snap = await provider.getMetrics(c);
        if (snap) next.set(c.name, snap);
      } catch (e: any) { console.error(`metrics fetch failed for ${c.name}:`, e?.message ?? e); }
    }
    snapshots = next;
  }

  return {
    sessions,
    computes,
    agents: core.listAgents(core.findProjectRoot(process.cwd()) ?? undefined),
    flows: core.listFlows(),
    unreadCounts,
    snapshots,
    computeLogs: prev.computeLogs,
  };
}

/** Shallow fingerprint: only re-render when data actually changes. */
function fingerprint(data: Payload): string {
  const s = data.sessions.map(s => `${s.id}:${s.status}:${s.session_id}:${s.error ?? ""}`).join("|");
  const compute = data.computes.map(compute => `${compute.name}:${compute.status}`).join("|");
  const u = [...data.unreadCounts.entries()].map(([k, v]) => `${k}=${v}`).join(",");
  // Include a simple metrics hash (cpu values change → fingerprint changes)
  const m = [...data.snapshots.entries()].map(([k, v]) => `${k}:${v.metrics.cpu.toFixed(0)}`).join(",");
  const a = data.agents.map(a => `${a.name}:${a._source}`).join("|");
  return `${s};${compute};${u};${m};${a}`;
}

/**
 * Poll the store with setInterval. Only triggers a React re-render
 * when the data actually changes (checked via fingerprint).
 * Exposes refresh() for immediate updates after mutations.
 */
export function useStore(refreshMs = 3000): StoreData {
  const [ver, setVer] = useState(0);
  const [initialLoading, setInitialLoading] = useState(true);
  const emptyPayload: Payload = {
    sessions: [], computes: [], agents: [], flows: [],
    unreadCounts: new Map(), snapshots: new Map(), computeLogs: new Map(),
  };
  const dataRef = useRef<Payload>(emptyPayload);
  const fpRef = useRef("");
  const running = useRef(false);
  const pollCount = useRef(0);

  const doRefresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      pollCount.current++;
      // Fetch metrics every 3rd cycle (~9s) to avoid hammering
      const metricsThisCycle = pollCount.current % 3 === 1;
      const data = await fetchAll(dataRef.current, metricsThisCycle);
      const fp = fingerprint(data);
      if (fp !== fpRef.current) {
        fpRef.current = fp;
        dataRef.current = data;
        setVer(v => v + 1);
      }
      setInitialLoading(false);
    } catch (e: any) { console.error("store refresh failed:", e?.message ?? e); }
    running.current = false;
  }, []);

  useEffect(() => {
    doRefresh();
    const t = setInterval(doRefresh, refreshMs);
    return () => clearInterval(t);
  }, [doRefresh, refreshMs]);

  // Sync refresh: re-read DB immediately, skip reconciliation + metrics
  const refresh = useCallback(() => {
    const sessions = core.listSessions({ limit: 50 });
    const computes = core.listCompute();
    const unreadCounts = new Map<string, number>();
    for (const s of sessions) {
      const count = core.getUnreadCount(s.id);
      if (count > 0) unreadCounts.set(s.id, count);
    }
    const data: Payload = {
      sessions, computes,
      agents: core.listAgents(core.findProjectRoot(process.cwd()) ?? undefined),
      flows: core.listFlows(),
      unreadCounts,
      snapshots: dataRef.current.snapshots, // keep existing metrics
      computeLogs: dataRef.current.computeLogs,
    };
    fpRef.current = fingerprint(data);
    dataRef.current = data;
    setVer(v => v + 1);
  }, []);

  // addComputeLog: append a log entry for a compute (for provisioning output etc.)
  const addComputeLog = useCallback((name: string, message: string) => {
    const logs = dataRef.current.computeLogs;
    const entries = [...(logs.get(name) ?? [])];
    const ts = new Date().toISOString().slice(11, 19);
    entries.push(`${ts}  ${message}`);
    if (entries.length > 50) entries.splice(0, entries.length - 50);
    const next = new Map(logs);
    next.set(name, entries);
    dataRef.current = { ...dataRef.current, computeLogs: next };
    setVer(v => v + 1);
  }, []);

  return { ...dataRef.current, refreshing: false, initialLoading, refresh, addComputeLog };
}
