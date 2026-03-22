// ── Shared mutable state ─────────────────────────────────────────────────────

import * as core from "../core/index.js";
import type { HostSnapshot } from "../compute/types.js";

export type Tab = "sessions" | "agents" | "pipelines" | "recipes" | "hosts";
export const TABS: Tab[] = ["sessions", "agents", "pipelines", "recipes", "hosts"];

export const state = {
  tab: "sessions" as Tab,
  sel: 0,
  sessions: [] as core.Session[],
  agents: [] as ReturnType<typeof core.listAgents>,
  pipelines: [] as ReturnType<typeof core.listPipelines>,
  hosts: [] as core.Host[],
  hostSnapshots: new Map<string, HostSnapshot>(),
  hostLogs: new Map<string, string[]>(),  // per-host activity log
  eventViewMode: false,
  eventSel: 0,
};

export function addHostLog(hostName: string, message: string) {
  const logs = state.hostLogs.get(hostName) ?? [];
  const ts = new Date().toISOString().slice(11, 19);
  logs.push(`${ts}  ${message}`);
  // Keep last 50 entries
  if (logs.length > 50) logs.splice(0, logs.length - 50);
  state.hostLogs.set(hostName, logs);
}

export function selectedSession(): core.Session | null {
  const topLevel = state.sessions.filter((s) => !s.parent_id);
  return topLevel[state.sel] ?? null;
}

export function selectedHost(): core.Host | null {
  return state.hosts[state.sel] ?? null;
}

export function refresh() {
  try {
    state.sessions = core.listSessions({ limit: 50 });
    state.agents = core.listAgents();
    state.pipelines = core.listPipelines();
    state.hosts = core.listHosts();

    // Prune stale snapshots and logs for deleted hosts
    const hostNames = new Set(state.hosts.map(h => h.name));
    for (const key of state.hostSnapshots.keys()) {
      if (!hostNames.has(key)) state.hostSnapshots.delete(key);
    }
    for (const key of state.hostLogs.keys()) {
      if (!hostNames.has(key)) state.hostLogs.delete(key);
    }
  } catch (e) {
    // SQLite may be briefly locked by another process - skip this refresh
  }
}
