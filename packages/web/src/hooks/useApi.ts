const BASE = window.location.origin;
const TOKEN = new URLSearchParams(window.location.search).get("token");

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  return headers;
}

function authParams(): string {
  return TOKEN ? `?token=${TOKEN}` : "";
}

export async function fetchApi<T>(path: string, opts?: RequestInit): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const url = opts?.method === "POST" || opts?.method === "PUT" || opts?.method === "DELETE"
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

async function apiPost<T>(path: string, body?: any): Promise<T> {
  return fetchApi<T>(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const api = {
  // Sessions
  getSessions: () => fetchApi<any[]>("/api/sessions"),
  getSession: (id: string) => fetchApi<any>(`/api/sessions/${id}`),
  getOutput: (id: string) => fetchApi<any>(`/api/sessions/${id}/output`),
  getEvents: (id: string) => fetchApi<any[]>(`/api/sessions/${id}/events`),
  getMessages: (id: string) => fetchApi<any>(`/api/sessions/${id}/messages`),
  exportSession: (id: string) => fetchApi<any>(`/api/sessions/${id}/export`),
  createSession: (data: any) => apiPost<any>("/api/sessions", data),
  importSession: (data: any) => apiPost<any>("/api/sessions/import", data),
  dispatch: (id: string) => apiPost<any>(`/api/sessions/${id}/dispatch`),
  stop: (id: string) => apiPost<any>(`/api/sessions/${id}/stop`),
  restart: (id: string) => apiPost<any>(`/api/sessions/${id}/restart`),
  deleteSession: (id: string) => apiPost<any>(`/api/sessions/${id}/delete`),
  undelete: (id: string) => apiPost<any>(`/api/sessions/${id}/undelete`),
  fork: (id: string, name?: string) => apiPost<any>(`/api/sessions/${id}/fork`, { name }),
  send: (id: string, message: string) => apiPost<any>(`/api/sessions/${id}/send`, { message }),
  pause: (id: string, reason?: string) => apiPost<any>(`/api/sessions/${id}/pause`, { reason }),
  interrupt: (id: string) => apiPost<any>(`/api/sessions/${id}/interrupt`),
  archive: (id: string) => apiPost<any>(`/api/sessions/${id}/archive`),
  restore: (id: string) => apiPost<any>(`/api/sessions/${id}/restore`),
  advance: (id: string) => apiPost<any>(`/api/sessions/${id}/advance`),
  complete: (id: string) => apiPost<any>(`/api/sessions/${id}/complete`),
  spawnSubagent: (id: string, data: any) => apiPost<any>(`/api/sessions/${id}/spawn-subagent`, data),

  // Todos & Verification
  getTodos: (id: string) => fetchApi<any>(`/api/sessions/${id}/todos`),
  addTodo: (id: string, content: string) => apiPost<any>(`/api/sessions/${id}/todos`, { content }),
  toggleTodo: (id: number) => apiPost<any>(`/api/todos/${id}/toggle`),
  deleteTodo: (id: number) => apiPost<any>(`/api/todos/${id}/delete`),
  runVerification: (id: string) => apiPost<any>(`/api/sessions/${id}/verify`),

  // Costs
  getCosts: () => fetchApi<any>("/api/costs"),
  exportCosts: (format: string) => fetchApi<any>(`/api/costs/export?format=${format}`),

  // Search
  search: (q: string) => fetchApi<any>(`/api/search?q=${encodeURIComponent(q)}`),
  searchGlobal: (q: string) => fetchApi<any>(`/api/search/global?q=${encodeURIComponent(q)}`),

  // History (Claude Code transcripts)
  getClaudeSessions: () => fetchApi<any[]>("/api/history/sessions"),
  getConversation: (sessionId: string, limit = 50) => fetchApi<any[]>(`/api/history/conversation/${encodeURIComponent(sessionId)}?limit=${limit}`),
  refreshHistory: () => apiPost<any>("/api/history/refresh"),
  rebuildHistory: () => apiPost<any>("/api/history/rebuild"),

  // System
  getStatus: () => fetchApi<any>("/api/status"),
  getGroups: () => fetchApi<string[]>("/api/groups"),
  getConfig: () => fetchApi<any>("/api/config"),

  // Profiles
  getProfiles: () => fetchApi<any[]>("/api/profiles"),
  createProfile: (name: string, desc?: string) => apiPost<any>("/api/profiles", { name, description: desc }),
  deleteProfile: (name: string) => fetchApi<any>(`/api/profiles/${name}`, { method: "DELETE" }),

  // Tools & MCP
  getTools: (dir?: string) => fetchApi<any[]>(`/api/tools${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`),
  attachMcp: (dir: string, name: string, config: any) => apiPost<any>("/api/mcp/attach", { dir, name, config }),
  detachMcp: (dir: string, name: string) => apiPost<any>("/api/mcp/detach", { dir, name }),

  // Skills & Recipes
  getSkills: () => fetchApi<any[]>("/api/skills"),
  createSkill: (data: any) => apiPost<any>("/api/skills", data),
  deleteSkill: (name: string, scope?: string) => fetchApi<any>(`/api/skills/${encodeURIComponent(name)}${scope ? `?scope=${scope}` : ""}`, { method: "DELETE" }),
  getRecipes: () => fetchApi<any[]>("/api/recipes"),
  deleteRecipe: (name: string, scope?: string) => fetchApi<any>(`/api/recipes/${encodeURIComponent(name)}${scope ? `?scope=${scope}` : ""}`, { method: "DELETE" }),

  // Agents & Flows
  getAgents: () => fetchApi<any[]>("/api/agents"),
  createAgent: (data: any) => apiPost<any>("/api/agents", data),
  updateAgent: (name: string, data: any) => fetchApi<any>(`/api/agents/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteAgent: (name: string) => fetchApi<any>(`/api/agents/${encodeURIComponent(name)}`, { method: "DELETE" }),
  getFlows: () => fetchApi<any[]>("/api/flows"),
  getFlowDetail: (name: string) => fetchApi<any>(`/api/flows/${encodeURIComponent(name)}`),
  createFlow: (data: any) => apiPost<any>("/api/flows", data),
  deleteFlow: (name: string) => fetchApi<any>(`/api/flows/${encodeURIComponent(name)}`, { method: "DELETE" }),

  // Worktrees
  getWorktrees: () => fetchApi<any[]>("/api/worktrees"),
  worktreeDiff: (id: string) => fetchApi<any>(`/api/worktrees/${id}/diff`),
  finishWorktree: (id: string, opts?: any) => apiPost<any>(`/api/worktrees/${id}/finish`, opts),
  worktreeCreatePR: (id: string, opts?: any) => apiPost<any>(`/api/worktrees/${id}/create-pr`, opts),
  cleanupWorktrees: () => apiPost<any>("/api/worktrees/cleanup"),

  // Conductor
  getLearnings: () => fetchApi<any>("/api/conductor/learnings"),
  recordLearning: (title: string, desc: string) => apiPost<any>("/api/conductor/learn", { title, description: desc }),

  // Memory
  getMemories: (scope?: string) => fetchApi<any[]>(`/api/memory${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`),
  recallMemory: (q: string) => fetchApi<any[]>(`/api/memory/recall?q=${encodeURIComponent(q)}`),
  addMemory: (content: string, opts?: any) => apiPost<any>("/api/memory", { content, ...opts }),
  forgetMemory: (id: string) => fetchApi<any>(`/api/memory/${id}`, { method: "DELETE" }),

  // Knowledge
  ingestKnowledge: (path: string, opts?: any) => apiPost<any>("/api/knowledge/ingest", { path, ...opts }),

  // Schedules
  getSchedules: () => fetchApi<any[]>("/api/schedules"),
  createSchedule: (data: any) => apiPost<any>("/api/schedules", data),
  deleteSchedule: (id: string) => apiPost<any>(`/api/schedules/${id}/delete`),
  enableSchedule: (id: string) => apiPost<any>(`/api/schedules/${id}/enable`),
  disableSchedule: (id: string) => apiPost<any>(`/api/schedules/${id}/disable`),

  // Compute
  getCompute: () => fetchApi<any[]>("/api/compute"),
  createCompute: (data: any) => apiPost<any>("/api/compute", data),
  getComputeDetail: (name: string) => fetchApi<any>(`/api/compute/${name}`),
  provisionCompute: (name: string) => apiPost<any>(`/api/compute/${name}/provision`),
  startCompute: (name: string) => apiPost<any>(`/api/compute/${name}/start`),
  stopCompute: (name: string) => apiPost<any>(`/api/compute/${name}/stop`),
  destroyCompute: (name: string) => apiPost<any>(`/api/compute/${name}/destroy`),
  deleteCompute: (name: string) => apiPost<any>(`/api/compute/${name}/delete`),

  // Repo Map
  getRepoMap: (dir?: string) => fetchApi<any>(`/api/repo-map${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`),
};
