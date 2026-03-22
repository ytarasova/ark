// ── Shared mutable state ─────────────────────────────────────────────────────

import * as core from "../core/index.js";
import type { HostSnapshot } from "../compute/types.js";

export type Tab = "sessions" | "agents" | "pipelines" | "recipes" | "hosts";

export const state = {
  tab: "sessions" as Tab,
  sel: 0,
  sessions: [] as core.Session[],
  agents: [] as ReturnType<typeof core.listAgents>,
  pipelines: [] as ReturnType<typeof core.listPipelines>,
  hosts: [] as core.Host[],
  hostSnapshots: new Map<string, HostSnapshot>(),
  eventViewMode: false,
  eventSel: 0,
};

export function refresh() {
  try {
    state.sessions = core.listSessions({ limit: 50 });
    state.agents = core.listAgents();
    state.pipelines = core.listPipelines();
    state.hosts = core.listHosts();
  } catch (e) {
    // SQLite may be briefly locked by another process — skip this refresh
  }
}
