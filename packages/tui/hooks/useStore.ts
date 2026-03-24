import { useState, useEffect, useRef, useCallback } from "react";
import * as core from "../../core/index.js";

export interface StoreData {
  sessions: core.Session[];
  computes: core.Compute[];
  agents: ReturnType<typeof core.listAgents>;
  flows: ReturnType<typeof core.listFlows>;
  /** Unread message counts per session ID. */
  unreadCounts: Map<string, number>;
  refreshing: boolean;
  /** Force an immediate refresh (call after mutations like delete/stop). */
  refresh: () => void;
}

/** Track pane snapshots for diff-based idle detection. */
const paneSnapshots = new Map<string, { text: string; time: number }>();

/**
 * Reconcile DB sessions with tmux reality.
 */
async function reconcileSessions(sessions: core.Session[]): Promise<void> {
  for (const s of sessions) {
    if (s.status !== "running" || !s.session_id) continue;
    const exists = await core.sessionExistsAsync(s.session_id);

    if (!exists) {
      let lastOutput = "";
      try {
        lastOutput = (await core.capturePaneAsync(s.session_id, { lines: 30 })).trim();
      } catch {}

      const error = lastOutput
        ? `Agent exited. Last output: ${lastOutput.split("\n").pop()?.slice(0, 100) ?? "unknown"}`
        : "Agent process exited";

      core.updateSession(s.id, { status: "failed", error, session_id: null });
      core.logEvent(s.id, "agent_exited", {
        stage: s.stage ?? undefined,
        actor: "system",
        data: { last_output: lastOutput.slice(0, 500) },
      });
      s.status = "failed";
      s.error = error;
      s.session_id = null;
      continue;
    }

    // Diff-based idle detection
    try {
      const output = await core.capturePaneAsync(s.session_id, { lines: 15 });
      const text = output.trim();
      const prev = paneSnapshots.get(s.id);
      paneSnapshots.set(s.id, { text, time: Date.now() });

      if (
        text.includes("AskUserQuestion") ||
        (text.includes("Allow") && text.includes("Deny"))
      ) {
        s.status = "waiting";
        continue;
      }

      if (prev && prev.text === text && Date.now() - prev.time > 2000) {
        s.status = "waiting";
      }
    } catch {}
  }
}

type Payload = Omit<StoreData, "refreshing" | "refresh">;

/** Fetch all store data in one shot. */
async function fetchAll(): Promise<Payload> {
  const sessions = core.listSessions({ limit: 50 });
  await reconcileSessions(sessions);
  const computes = core.listCompute();

  // Batch unread counts — one query per session, but only once per poll
  const unreadCounts = new Map<string, number>();
  for (const s of sessions) {
    const count = core.getUnreadCount(s.id);
    if (count > 0) unreadCounts.set(s.id, count);
  }

  return {
    sessions,
    computes,
    agents: core.listAgents(),
    flows: core.listFlows(),
    unreadCounts,
  };
}

/** Shallow fingerprint: only re-render when data actually changes. */
function fingerprint(data: Payload): string {
  const s = data.sessions.map(s => `${s.id}:${s.status}:${s.session_id}:${s.error ?? ""}`).join("|");
  const h = data.computes.map(h => `${h.name}:${h.status}`).join("|");
  const u = [...data.unreadCounts.entries()].map(([k, v]) => `${k}=${v}`).join(",");
  return `${s};${h};${u}`;
}

/**
 * Poll the store with setInterval. Only triggers a React re-render
 * when the data actually changes (checked via fingerprint).
 * Exposes refresh() for immediate updates after mutations.
 */
export function useStore(refreshMs = 3000): StoreData {
  const [ver, setVer] = useState(0);
  const dataRef = useRef<Payload>({
    sessions: [], computes: [], agents: [], flows: [],
    unreadCounts: new Map(),
  });
  const fpRef = useRef("");
  const running = useRef(false);

  const doRefresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const data = await fetchAll();
      const fp = fingerprint(data);
      if (fp !== fpRef.current) {
        fpRef.current = fp;
        dataRef.current = data;
        setVer(v => v + 1);
      }
    } catch {}
    running.current = false;
  }, []);

  useEffect(() => {
    doRefresh();
    const t = setInterval(doRefresh, refreshMs);
    return () => clearInterval(t);
  }, [doRefresh, refreshMs]);

  // Sync refresh: re-read DB immediately, skip reconciliation (fast path)
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
      agents: core.listAgents(),
      flows: core.listFlows(),
      unreadCounts,
    };
    fpRef.current = fingerprint(data);
    dataRef.current = data;
    setVer(v => v + 1);
  }, []);

  return { ...dataRef.current, refreshing: false, refresh };
}
