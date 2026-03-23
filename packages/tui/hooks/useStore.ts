import { useState, useEffect, useCallback } from "react";
import * as core from "../../core/index.js";

export interface StoreData {
  sessions: core.Session[];
  hosts: core.Host[];
  agents: ReturnType<typeof core.listAgents>;
  pipelines: ReturnType<typeof core.listPipelines>;
  refreshing: boolean;
}

/**
 * Reconcile DB sessions with tmux reality.
 * Marks "running" sessions as "failed" if their tmux session is dead.
 */
async function reconcileSessions(sessions: core.Session[]): Promise<void> {
  for (const s of sessions) {
    if (s.status !== "running" || !s.session_id) continue;

    const exists = await core.sessionExistsAsync(s.session_id);
    if (exists) continue;

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
  }
}

/**
 * Fetch all store data from SQLite.
 */
function fetchStoreData(): Omit<StoreData, "refreshing"> {
  return {
    sessions: core.listSessions({ limit: 50 }),
    hosts: core.listHosts(),
    agents: core.listAgents(),
    pipelines: core.listPipelines(),
  };
}

export function useStore(refreshMs = 3000): StoreData {
  const [data, setData] = useState<StoreData>({
    sessions: [],
    hosts: [],
    agents: [],
    pipelines: [],
    refreshing: false,
  });

  const refresh = useCallback(async () => {
    try {
      const store = fetchStoreData();
      await reconcileSessions(store.sessions);
      setData({ ...store, refreshing: false });
    } catch (e: any) {
      // Log refresh errors - don't crash the TUI, retry on next cycle
      const { appendFileSync } = require("fs");
      const { join } = require("path");
      const { homedir } = require("os");
      try {
        appendFileSync(
          join(homedir(), ".ark", "logs", "tui.log"),
          `${new Date().toISOString()} [WARN] Store refresh failed: ${e.message}\n`,
        );
      } catch {}
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, refreshMs);
    return () => clearInterval(t);
  }, [refresh, refreshMs]);

  return data;
}
