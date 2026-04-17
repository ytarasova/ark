const BASE = window.location.origin;
const TOKEN = new URLSearchParams(window.location.search).get("token");

let rpcId = 0;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  return headers;
}

/**
 * Call the JSON-RPC endpoint. All API methods go through this single function.
 */
async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const id = ++rpcId;
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message || "RPC error");
  }
  return data.result as T;
}

/**
 * SSE event source URL (still a separate endpoint).
 */
export function sseUrl(): string {
  const sep = "?";
  return `${BASE}/api/events/stream${TOKEN ? `${sep}token=${TOKEN}` : ""}`;
}

/**
 * Fetch helper for non-RPC endpoints (SSE URL construction, etc).
 * Kept for backward compatibility but most callers should use `api.*` below.
 */
export async function fetchApi<T>(path: string, opts?: RequestInit): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const url =
    opts?.method === "POST" || opts?.method === "PUT" || opts?.method === "DELETE"
      ? `${BASE}${path}`
      : `${BASE}${path}${TOKEN ? `${sep}token=${TOKEN}` : ""}`;
  const resp = await fetch(url, {
    ...opts,
    headers: {
      ...authHeaders(),
      ...opts?.headers,
    },
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ message: resp.statusText }));
    throw new Error(body.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export const api = {
  // Sessions
  getSessions: (filters?: Record<string, unknown>) =>
    rpc<{ sessions: any[] }>("session/list", { limit: 200, ...filters }).then((r) => r.sessions),
  getSession: (id: string) => rpc<any>("session/read", { sessionId: id, include: ["events"] }),
  getOutput: (id: string) =>
    rpc<{ output: string }>("session/output", { sessionId: id }).then((r) => ({ ok: true, output: r.output })),
  getRecording: (id: string) => rpc<{ ok: boolean; output: string | null }>("session/recording", { sessionId: id }),
  getEvents: (id: string) => rpc<{ events: any[] }>("session/events", { sessionId: id }).then((r) => r.events),
  getMessages: (id: string) => rpc<any>("session/messages", { sessionId: id }),
  exportSession: (id: string) => rpc<any>("session/export-data", { sessionId: id }),
  createSession: (data: any) => rpc<any>("session/start", data).then((r) => ({ ok: true, session: r.session })),
  importSession: (data: any) => rpc<any>("session/import", data),
  dispatch: (id: string) => rpc<any>("session/dispatch", { sessionId: id }),
  stop: (id: string) => rpc<any>("session/stop", { sessionId: id }),
  restart: (id: string) => rpc<any>("session/resume", { sessionId: id }),
  deleteSession: (id: string) => rpc<any>("session/delete", { sessionId: id }),
  undelete: (id: string) => rpc<any>("session/undelete", { sessionId: id }),
  fork: (id: string, name?: string) =>
    rpc<any>("session/clone", { sessionId: id, name }).then((r) => ({ ok: true, sessionId: r.session?.id })),
  send: (id: string, message: string) => rpc<any>("message/send", { sessionId: id, content: message }),
  markRead: (id: string) => rpc<any>("message/markRead", { sessionId: id }),
  getUnreadCounts: () => rpc<{ counts: Record<string, number> }>("session/unread-counts").then((r) => r.counts),
  pause: (id: string, reason?: string) => rpc<any>("session/pause", { sessionId: id, reason }),
  interrupt: (id: string) => rpc<any>("session/interrupt", { sessionId: id }),
  archive: (id: string) => rpc<any>("session/archive", { sessionId: id }),
  restore: (id: string) => rpc<any>("session/restore", { sessionId: id }),
  advance: (id: string) => rpc<any>("session/advance", { sessionId: id }),
  complete: (id: string) => rpc<any>("session/complete", { sessionId: id }),
  spawnSubagent: (id: string, data: any) => rpc<any>("session/spawn", { sessionId: id, ...data }),

  // Todos & Verification
  getTodos: (id: string) => rpc<{ todos: any[] }>("todo/list", { sessionId: id }).then((r) => r.todos),
  addTodo: (id: string, content: string) =>
    rpc<any>("todo/add", { sessionId: id, content }).then((r) => ({ ok: true, todo: r.todo })),
  toggleTodo: (id: number) => rpc<any>("todo/toggle", { id }).then((r) => ({ ok: true, todo: r.todo })),
  deleteTodo: (id: number) => rpc<any>("todo/delete", { id }),
  runVerification: (id: string) => rpc<any>("verify/run", { sessionId: id }),

  // Costs
  getCosts: () =>
    rpc<{ costs: any[]; total: number }>("costs/read").then((r) => ({ sessions: r.costs, total: r.total })),
  getSessionCost: (id: string) =>
    rpc<{
      cost: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      total_tokens: number;
    }>("costs/session", { sessionId: id }),
  exportCosts: (format: string) => rpc<any>("cost/export", { format }),

  // Search
  search: (q: string) => rpc<any>("search/sessions", { query: q }),
  searchGlobal: (q: string) => rpc<any>("search/global", { query: q }),

  // History (Claude Code transcripts)
  getClaudeSessions: () => rpc<{ items: any[] }>("history/list").then((r) => r.items),
  getConversation: (sessionId: string, limit = 50) =>
    rpc<{ turns: any[] }>("session/conversation", { sessionId, limit }).then((r) => r.turns || []),
  refreshHistory: () => rpc<any>("history/refresh-and-index"),
  rebuildHistory: () => rpc<any>("history/rebuild-fts"),

  // Dashboard
  getDashboardSummary: () => rpc<any>("dashboard/summary"),

  // System
  getStatus: () => rpc<any>("status/get"),
  getDaemonStatus: () =>
    rpc<{
      conductor: { online: boolean; url: string };
      arkd: { online: boolean; url: string };
      router: { online: boolean };
    }>("daemon/status"),
  getGroups: () => rpc<{ groups: any[] }>("group/list").then((r) => r.groups.map((g: any) => g.name)),
  getConfig: () => rpc<any>("config/get"),

  // Profiles
  getProfiles: () => rpc<{ profiles: any[] }>("profile/list").then((r) => r.profiles),
  createProfile: (name: string, desc?: string) =>
    rpc<any>("profile/create", { name, description: desc }).then((r) => ({ ok: true, profile: r.profile })),
  deleteProfile: (name: string) => rpc<any>("profile/delete", { name }).then(() => ({ ok: true, message: "Deleted" })),

  // Tools & MCP
  getTools: (dir?: string) => rpc<{ tools: any[] }>("tools/list", { projectRoot: dir }).then((r) => r.tools),
  attachMcp: (dir: string, name: string, config: any) => rpc<any>("mcp/attach-by-dir", { dir, name, config }),
  detachMcp: (dir: string, name: string) => rpc<any>("mcp/detach-by-dir", { dir, name }),

  // Skills & Recipes
  getSkills: () => rpc<{ skills: any[] }>("skill/list").then((r) => r.skills),
  createSkill: (data: any) => rpc<any>("skill/save", data).then((r) => ({ ok: true, name: r.name })),
  deleteSkill: (name: string, scope?: string) => rpc<any>("skill/delete", { name, scope }),
  getRecipes: () => rpc<{ recipes: any[] }>("recipe/list").then((r) => r.recipes),
  deleteRecipe: (name: string, scope?: string) => rpc<any>("recipe/delete", { name, scope: scope ?? "global" }),

  // Agents, Runtimes & Flows
  getAgents: () => rpc<{ agents: any[] }>("agent/list").then((r) => r.agents),
  getRuntimes: () => rpc<{ runtimes: any[] }>("runtime/list").then((r) => r.runtimes),
  getRuntimeDetail: (name: string) => rpc<any>("runtime/read", { name }).then((r) => r.runtime),
  createAgent: (data: any) => rpc<any>("agent/create", data).then((r) => ({ ok: true, name: r.name })),
  updateAgent: (name: string, data: any) => rpc<any>("agent/update", { ...data, name }),
  deleteAgent: (name: string) => rpc<any>("agent/delete", { name }),
  getFlows: () => rpc<{ flows: any[] }>("flow/list").then((r) => r.flows),
  getFlowDetail: (name: string) =>
    rpc<any>("flow/read", { name }).then((r) => {
      const flow = r.flow;
      return {
        name: flow.name,
        description: flow.description,
        edges: flow.edges,
        stages: (flow.stages ?? []).map((st: any) => ({
          name: st.name,
          gate: st.gate,
          agent: st.agent,
          type: st.type,
          optional: st.optional,
          on_failure: st.on_failure,
          verify: st.verify,
          depends_on: st.depends_on,
          task: st.task,
          action: st.action,
        })),
      };
    }),
  createFlow: (data: any) => rpc<any>("flow/create", data).then((r) => ({ ok: true, name: r.name })),
  deleteFlow: (name: string) => rpc<any>("flow/delete", { name }),

  // Worktrees
  getWorktrees: () => rpc<{ worktrees: any[] }>("worktree/list").then((r) => r.worktrees),
  worktreeDiff: (id: string) => rpc<any>("worktree/diff", { sessionId: id }),
  finishWorktree: (id: string, opts?: any) => rpc<any>("worktree/finish", { sessionId: id, ...(opts ?? {}) }),
  worktreeCreatePR: (id: string, opts?: any) => rpc<any>("worktree/create-pr", { sessionId: id, ...(opts ?? {}) }),
  cleanupWorktrees: () => rpc<any>("worktree/cleanup"),

  // Conductor
  getLearnings: () => rpc<{ learnings: any[] }>("learning/list").then((r) => r.learnings),
  recordLearning: (title: string, desc: string) => rpc<any>("learning/add", { title, description: desc }),

  // Memory
  getMemories: (scope?: string) => rpc<{ memories: any[] }>("memory/list", { scope }).then((r) => r.memories),
  recallMemory: (q: string) => rpc<{ results: any[] }>("memory/recall", { query: q }).then((r) => r.results),
  addMemory: (content: string, opts?: any) =>
    rpc<any>("memory/add", { content, ...opts }).then((r) => ({ ok: true, entry: r.memory })),
  forgetMemory: (id: string) =>
    rpc<any>("memory/forget", { id }).then((r) => ({ ok: r.ok, message: r.ok ? "Forgotten" : "Not found" })),

  // Knowledge
  ingestKnowledge: (path: string, opts?: any) => rpc<any>("knowledge/ingest", { path, ...opts }),
  knowledgeSearch: (query: string, opts?: { types?: string[]; limit?: number }) =>
    rpc<{ results: any[] }>("knowledge/search", { query, ...opts }).then((r) => r.results),
  knowledgeStats: () => rpc<any>("knowledge/stats"),
  knowledgeIndex: (repo?: string) => rpc<any>("knowledge/index", { repo }),
  knowledgeExport: (dir?: string) => rpc<any>("knowledge/export", { dir }),
  knowledgeImport: (dir?: string) => rpc<any>("knowledge/import", { dir }),

  // Schedules
  getSchedules: () => rpc<{ schedules: any[] }>("schedule/list").then((r) => r.schedules),
  createSchedule: (data: any) => rpc<any>("schedule/create", data).then((r) => ({ ok: true, schedule: r.schedule })),
  deleteSchedule: (id: string) =>
    rpc<any>("schedule/delete", { id }).then((r) => ({ ok: r.ok, message: r.ok ? "Deleted" : "Not found" })),
  enableSchedule: (id: string) => rpc<any>("schedule/enable", { id }).then(() => ({ ok: true })),
  disableSchedule: (id: string) => rpc<any>("schedule/disable", { id }).then(() => ({ ok: true })),

  // Compute
  getCompute: () => rpc<{ targets: any[] }>("compute/list").then((r) => r.targets),
  createCompute: (data: any) => rpc<any>("compute/create", data).then((r) => ({ ok: true, compute: r.compute })),
  getComputeDetail: (name: string) => rpc<any>("compute/read", { name }).then((r) => r.compute),
  provisionCompute: (name: string) => rpc<any>("compute/provision", { name }),
  startCompute: (name: string) => rpc<any>("compute/start-instance", { name }),
  stopCompute: (name: string) => rpc<any>("compute/stop-instance", { name }),
  destroyCompute: (name: string) => rpc<any>("compute/destroy", { name }),
  deleteCompute: (name: string) => rpc<any>("compute/delete", { name }),
  getComputeSnapshot: (computeName?: string) =>
    rpc<{ snapshot: any }>("metrics/snapshot", computeName ? { computeName } : {}).then((r) => r.snapshot),
  killProcess: (pid: string) => rpc<{ ok: boolean }>("compute/kill-process", { pid }),
  getDockerLogs: (container: string, tail?: number) =>
    rpc<{ logs: string }>("compute/docker-logs", { container, tail: tail ?? 100 }).then((r) => r.logs),
  dockerAction: (container: string, action: "stop" | "restart") =>
    rpc<{ ok: boolean }>("compute/docker-action", { container, action }),

  // Compute Templates
  listComputeTemplates: () => rpc<{ templates: any[] }>("compute/template/list").then((r) => r.templates),

  // Repo Map
  getRepoMap: (dir?: string) => rpc<any>("repo-map/get", { dir }),

  // Filesystem (local mode only -- for the folder picker in New Session)
  listDir: (path?: string) =>
    rpc<{
      cwd: string;
      parent: string | null;
      home: string;
      entries: { name: string; path: string; isGitRepo?: boolean }[];
    }>("fs/list-dir", path === undefined ? {} : { path }),
};
