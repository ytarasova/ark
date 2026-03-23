import { useQuery } from "@tanstack/react-query";
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

async function fetchStore(): Promise<Omit<StoreData, "refreshing">> {
  const sessions = core.listSessions({ limit: 50 });
  await reconcileSessions(sessions);
  return {
    sessions,
    hosts: core.listHosts(),
    agents: core.listAgents(),
    pipelines: core.listPipelines(),
  };
}

export function useStore(refreshMs = 3000): StoreData {
  const { data, isFetching } = useQuery({
    queryKey: ["store"],
    queryFn: fetchStore,
    refetchInterval: refreshMs,
    staleTime: refreshMs - 500, // data considered fresh for most of the interval
    placeholderData: (prev) => prev, // keep previous data while refetching (stale-while-revalidate)
  });

  return {
    sessions: data?.sessions ?? [],
    hosts: data?.hosts ?? [],
    agents: data?.agents ?? [],
    pipelines: data?.pipelines ?? [],
    refreshing: isFetching,
  };
}
