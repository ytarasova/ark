import { useState, useEffect, useRef, useCallback } from "react";
import * as core from "../../core/index.js";

export interface StoreData {
  sessions: core.Session[];
  computes: core.Compute[];
  agents: ReturnType<typeof core.listAgents>;
  flows: ReturnType<typeof core.listFlows>;
  refreshing: boolean;
  /** Force an immediate refresh (call after mutations like delete/stop). */
  refresh: () => void;
}

/**
 * Reconcile DB sessions with tmux reality.
 */
async function reconcileSessions(sessions: core.Session[]): Promise<void> {
  for (const s of sessions) {
    if (s.status !== "running" || !s.session_id) continue;
    const exists = await core.sessionExistsAsync(s.session_id);

    if (!exists) {
      // Tmux session gone — agent crashed or exited
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

    // Tmux alive — check if Claude is waiting for user input
    try {
      const output = await core.capturePaneAsync(s.session_id, { lines: 5 });
      const lastLines = output.trim().split("\n").slice(-3).join("\n");
      // Claude shows ❯ prompt when waiting for input, or AskUserQuestion
      const isWaiting = lastLines.includes("❯") && !lastLines.includes("⏺");
      if (isWaiting && s.status === "running") {
        s.status = "waiting";
      }
    } catch {}
  }
}

/** Shallow fingerprint: only re-render when session/compute list actually changes. */
function fingerprint(sessions: core.Session[], computes: core.Compute[]): string {
  const s = sessions.map(s => `${s.id}:${s.status}:${s.session_id}:${s.error ?? ""}`).join("|");
  const h = computes.map(h => `${h.name}:${h.status}`).join("|");
  return s + ";" + h;
}

/**
 * Poll the store with setInterval. Only triggers a React re-render
 * when the data actually changes (checked via fingerprint).
 * Exposes refresh() for immediate updates after mutations.
 */
export function useStore(refreshMs = 3000): StoreData {
  const [ver, setVer] = useState(0);
  const dataRef = useRef<Omit<StoreData, "refreshing" | "refresh">>({
    sessions: [], computes: [], agents: [], flows: [],
  });
  const fpRef = useRef("");
  const running = useRef(false);

  const doRefresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const sessions = core.listSessions({ limit: 50 });
      await reconcileSessions(sessions);
      const computes = core.listCompute();
      const fp = fingerprint(sessions, computes);
      if (fp !== fpRef.current) {
        fpRef.current = fp;
        dataRef.current = {
          sessions,
          computes,
          agents: core.listAgents(),
          flows: core.listFlows(),
        };
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
    fpRef.current = fingerprint(sessions, computes);
    dataRef.current = {
      sessions,
      computes,
      agents: core.listAgents(),
      flows: core.listFlows(),
    };
    setVer(v => v + 1);
  }, []);

  return { ...dataRef.current, refreshing: false, refresh };
}
