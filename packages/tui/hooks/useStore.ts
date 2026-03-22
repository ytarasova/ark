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
        setData({
          sessions: core.listSessions({ limit: 50 }),
          hosts: core.listHosts(),
          agents: core.listAgents(),
          pipelines: core.listPipelines(),
        });
      } catch {
        // SQLite may be briefly locked by another process - skip this refresh
      }
    };
    refresh();
    const t = setInterval(refresh, refreshMs);
    return () => clearInterval(t);
  }, [refreshMs]);

  return data;
}
