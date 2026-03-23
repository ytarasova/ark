import { useState, useEffect } from "react";
import * as core from "../../core/index.js";

export interface StoreData {
  sessions: core.Session[];
  hosts: core.Host[];
  agents: ReturnType<typeof core.listAgents>;
  pipelines: ReturnType<typeof core.listPipelines>;
  refreshing: boolean;
}

export function useStore(refreshMs = 3000): StoreData {
  const [data, setData] = useState<StoreData>({
    sessions: [],
    hosts: [],
    agents: [],
    pipelines: [],
    refreshing: false,
  });

  useEffect(() => {
    let firstLoad = true;
    const refresh = () => {
      if (!firstLoad) {
        setData((prev) => ({ ...prev, refreshing: true }));
      }
      try {
        const sessions = core.listSessions({ limit: 50 });

        // Reconcile: if DB says "running" but tmux session is dead, mark as failed
        for (const s of sessions) {
          if (s.status === "running" && s.session_id) {
            if (!core.sessionExists(s.session_id)) {
              // Try to capture last output before marking dead
              let lastOutput = "";
              try {
                lastOutput = core.capturePane(s.session_id, { lines: 30 }).trim();
              } catch { /* session already gone */ }

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
        }

        setData({
          sessions,
          hosts: core.listHosts(),
          agents: core.listAgents(),
          pipelines: core.listPipelines(),
          refreshing: false,
        });
      } catch {
        setData((prev) => ({ ...prev, refreshing: false }));
        // SQLite may be briefly locked
      }
      firstLoad = false;
    };
    refresh();
    const t = setInterval(refresh, refreshMs);
    return () => clearInterval(t);
  }, [refreshMs]);

  return data;
}
