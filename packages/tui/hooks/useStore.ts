import { useState, useEffect } from "react";
import * as core from "../../core/index.js";

export interface StoreData {
  sessions: core.Session[];
  hosts: core.Host[];
  agents: ReturnType<typeof core.listAgents>;
  pipelines: ReturnType<typeof core.listPipelines>;
}

export function useStore(refreshMs = 3000): StoreData {
  const [data, setData] = useState<StoreData>({
    sessions: [],
    hosts: [],
    agents: [],
    pipelines: [],
  });

  useEffect(() => {
    const refresh = () => {
      try {
        const sessions = core.listSessions({ limit: 50 });

        // Reconcile: if DB says "running" but tmux session is dead, mark as failed
        for (const s of sessions) {
          if (s.status === "running" && s.session_id) {
            if (!core.sessionExists(s.session_id)) {
              core.updateSession(s.id, { status: "failed", error: "Agent process exited", session_id: null });
              s.status = "failed";
              s.error = "Agent process exited";
              s.session_id = null;
            }
          }
        }

        setData({
          sessions,
          hosts: core.listHosts(),
          agents: core.listAgents(),
          pipelines: core.listPipelines(),
        });
      } catch {
        // SQLite may be briefly locked
      }
    };
    refresh();
    const t = setInterval(refresh, refreshMs);
    return () => clearInterval(t);
  }, [refreshMs]);

  return data;
}
