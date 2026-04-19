import { HttpTransport } from "../transport/HttpTransport.js";
import type { WebTransport } from "../transport/types.js";
import type {
  SessionStartRequest,
  SessionStartResponse,
  SessionReadRequest,
  SessionReadResponse,
  SessionListRequest,
  SessionListResponse,
  SessionDeleteRequest,
  SessionDeleteResponse,
  SessionUndeleteRequest,
  SessionUndeleteResponse,
  SessionForkRequest,
  SessionForkResponse,
  SessionStopRequest,
  SessionStopResponse,
  SessionAdvanceRequest,
  SessionAdvanceResponse,
  SessionArchiveRequest,
  SessionArchiveResponse,
  SessionRestoreRequest,
  SessionRestoreResponse,
  ComputeListRequest,
  ComputeListResponse,
  ComputeCreateRequest,
  ComputeCreateResponse,
  ComputeReadRequest,
  ComputeReadResponse,
  FlowListRequest,
  FlowListResponse,
  FlowReadRequest,
  FlowReadResponse,
  AgentListRequest,
  AgentListResponse,
  SkillListRequest,
  SkillListResponse,
  ScheduleListRequest,
  ScheduleListResponse,
  ScheduleCreateRequest,
  ScheduleCreateResponse,
  CostsReadRequest,
  CostsReadResponse,
  DashboardSummaryRequest,
  DashboardSummaryResponse,
  TodoAddRequest,
  TodoAddResponse,
  TodoToggleRequest,
  TodoToggleResponse,
  KnowledgeStatsRequest,
  KnowledgeStatsResponse,
} from "../../../../protocol/rpc-schemas.js";

/**
 * Module-level transport. Defaults to `HttpTransport` so that call sites that
 * run before `<TransportProvider>` mounts still work (matches previous
 * direct-fetch behaviour). `setTransport()` is called by `TransportProvider`
 * to swap in a different implementation -- notably `MockTransport` in tests.
 *
 * See `packages/web/src/transport/TransportContext.tsx` for the provider and
 * `packages/web/src/transport/types.ts` for the interface.
 */
let _transport: WebTransport = new HttpTransport();

/** Replace the transport used by `api.*` and `fetchApi`. */
export function setTransport(t: WebTransport): void {
  _transport = t;
}

/** Get the current module-level transport. */
export function getTransport(): WebTransport {
  return _transport;
}

/**
 * Call the JSON-RPC endpoint. All API methods go through this single function.
 *
 * Most call sites below pick a typed Request/Response pair generated from the
 * Zod schemas in `packages/protocol/rpc-schemas.ts`. Methods not yet covered
 * by a schema keep their ad-hoc shapes and are marked with a TODO.
 */
function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  return _transport.rpc<T>(method, params);
}

/**
 * SSE event source URL for the main events stream. Returned fully-qualified.
 */
export function sseUrl(): string {
  return _transport.sseUrl("/api/events/stream");
}

/**
 * Fetch helper for non-RPC endpoints (SSE URL construction, etc).
 * Kept for backward compatibility but most callers should use `api.*` below.
 * Uses `HttpTransport`-provided base+token when available; otherwise falls
 * back to `window.location.origin` with no auth (primarily for tests).
 */
export async function fetchApi<T>(path: string, opts?: RequestInit): Promise<T> {
  const base =
    _transport instanceof HttpTransport
      ? _transport.getBase()
      : typeof window !== "undefined"
        ? window.location.origin
        : "";
  const token = _transport instanceof HttpTransport ? _transport.getToken() : null;

  const sep = path.includes("?") ? "&" : "?";
  const url =
    opts?.method === "POST" || opts?.method === "PUT" || opts?.method === "DELETE"
      ? `${base}${path}`
      : `${base}${path}${token ? `${sep}token=${token}` : ""}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(url, {
    ...opts,
    headers: {
      ...headers,
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
  // ── Sessions (Zod-typed) ──────────────────────────────────────────────────
  getSessions: (filters?: Partial<SessionListRequest>) =>
    rpc<SessionListResponse>("session/list", { limit: 200, ...(filters ?? {}) }).then((r) => r.sessions),
  getSession: (id: string) =>
    rpc<SessionReadResponse>("session/read", { sessionId: id, include: ["events"] } satisfies SessionReadRequest),
  createSession: (data: SessionStartRequest) =>
    rpc<SessionStartResponse>("session/start", data).then((r) => ({ ok: true as const, session: r.session })),
  stop: (id: string) => rpc<SessionStopResponse>("session/stop", { sessionId: id } satisfies SessionStopRequest),
  deleteSession: (id: string) =>
    rpc<SessionDeleteResponse>("session/delete", { sessionId: id } satisfies SessionDeleteRequest),
  undelete: (id: string) =>
    rpc<SessionUndeleteResponse>("session/undelete", { sessionId: id } satisfies SessionUndeleteRequest),
  forkSession: (id: string, name?: string) =>
    rpc<SessionForkResponse>("session/fork", { sessionId: id, name } satisfies SessionForkRequest),
  advance: (id: string) =>
    rpc<SessionAdvanceResponse>("session/advance", { sessionId: id } satisfies SessionAdvanceRequest),
  archive: (id: string) =>
    rpc<SessionArchiveResponse>("session/archive", { sessionId: id } satisfies SessionArchiveRequest),
  restore: (id: string) =>
    rpc<SessionRestoreResponse>("session/restore", { sessionId: id } satisfies SessionRestoreRequest),

  // ── Sessions (untyped, TODO: add Zod schema) ──────────────────────────────
  // TODO: add Zod schema for session/output
  getOutput: (id: string) =>
    rpc<{ output: string }>("session/output", { sessionId: id }).then((r) => ({ ok: true, output: r.output })),
  // TODO: add Zod schema for session/recording
  getRecording: (id: string) => rpc<{ ok: boolean; output: string | null }>("session/recording", { sessionId: id }),
  // TODO: add Zod schema for session/events
  getEvents: (id: string) => rpc<{ events: any[] }>("session/events", { sessionId: id }).then((r) => r.events),
  // TODO: add Zod schema for session/messages
  getMessages: (id: string) => rpc<any>("session/messages", { sessionId: id }),
  // TODO: add Zod schema for session/export-data
  exportSession: (id: string) => rpc<any>("session/export-data", { sessionId: id }),
  // TODO: add Zod schema for session/import
  importSession: (data: any) => rpc<any>("session/import", data),
  // TODO: add Zod schema for session/resume
  restart: (id: string) => rpc<any>("session/resume", { sessionId: id }),
  // TODO: add Zod schema for session/clone (separate from fork above)
  fork: (id: string, name?: string) =>
    rpc<any>("session/clone", { sessionId: id, name }).then((r) => ({ ok: true, sessionId: r.session?.id })),
  // TODO: add Zod schema for message/send
  send: (id: string, message: string) => rpc<any>("message/send", { sessionId: id, content: message }),
  // TODO: add Zod schema for message/markRead
  markRead: (id: string) => rpc<any>("message/markRead", { sessionId: id }),
  // TODO: add Zod schema for session/unread-counts
  getUnreadCounts: () => rpc<{ counts: Record<string, number> }>("session/unread-counts").then((r) => r.counts),
  // TODO: add Zod schema for session/pause
  pause: (id: string, reason?: string) => rpc<any>("session/pause", { sessionId: id, reason }),
  // TODO: add Zod schema for session/interrupt
  interrupt: (id: string) => rpc<any>("session/interrupt", { sessionId: id }),
  // TODO: add Zod schema for session/complete
  complete: (id: string) => rpc<any>("session/complete", { sessionId: id }),
  // TODO: add Zod schema for session/spawn
  spawnSubagent: (id: string, data: any) => rpc<any>("session/spawn", { sessionId: id, ...data }),

  // ── Todos & Verification ─────────────────────────────────────────────────
  // TODO: add Zod schema for todo/list
  getTodos: (id: string) => rpc<{ todos: any[] }>("todo/list", { sessionId: id }).then((r) => r.todos),
  addTodo: (id: string, content: string) =>
    rpc<TodoAddResponse>("todo/add", { sessionId: id, content } satisfies TodoAddRequest).then((r) => ({
      ok: true as const,
      todo: r.todo,
    })),
  toggleTodo: (id: number) =>
    rpc<TodoToggleResponse>("todo/toggle", { id } satisfies TodoToggleRequest).then((r) => ({
      ok: true as const,
      todo: r.todo,
    })),
  // TODO: add Zod schema for todo/delete
  deleteTodo: (id: number) => rpc<any>("todo/delete", { id }),
  // TODO: add Zod schema for verify/run
  runVerification: (id: string) => rpc<any>("verify/run", { sessionId: id }),

  // ── Costs ────────────────────────────────────────────────────────────────
  getCosts: () =>
    rpc<CostsReadResponse>("costs/read", {} satisfies CostsReadRequest).then((r) => ({
      sessions: r.costs,
      total: r.total,
    })),
  // TODO: add Zod schema for costs/session
  getSessionCost: (id: string) =>
    rpc<{
      cost: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      total_tokens: number;
    }>("costs/session", { sessionId: id }),
  // TODO: add Zod schema for cost/export
  exportCosts: (format: string) => rpc<any>("cost/export", { format }),

  // ── Search ───────────────────────────────────────────────────────────────
  // TODO: add Zod schema for search/sessions
  search: (q: string) => rpc<any>("search/sessions", { query: q }),
  // TODO: add Zod schema for search/global
  searchGlobal: (q: string) => rpc<any>("search/global", { query: q }),

  // ── History (Claude Code transcripts) ────────────────────────────────────
  // TODO: add Zod schema for history/list
  getClaudeSessions: () => rpc<{ items: any[] }>("history/list").then((r) => r.items),
  // TODO: add Zod schema for session/conversation
  getConversation: (sessionId: string, limit = 50) =>
    rpc<{ turns: any[] }>("session/conversation", { sessionId, limit }).then((r) => r.turns || []),
  // TODO: add Zod schema for history/refresh-and-index
  refreshHistory: () => rpc<any>("history/refresh-and-index"),
  // TODO: add Zod schema for history/rebuild-fts
  rebuildHistory: () => rpc<any>("history/rebuild-fts"),

  // ── Dashboard ────────────────────────────────────────────────────────────
  getDashboardSummary: () => rpc<DashboardSummaryResponse>("dashboard/summary", {} satisfies DashboardSummaryRequest),

  // ── System ───────────────────────────────────────────────────────────────
  // TODO: add Zod schema for status/get
  getStatus: () => rpc<any>("status/get"),
  // TODO: add Zod schema for daemon/status
  getDaemonStatus: () =>
    rpc<{
      conductor: { online: boolean; url: string };
      arkd: { online: boolean; url: string };
      router: { online: boolean };
    }>("daemon/status"),
  // TODO: add Zod schema for group/list
  getGroups: () => rpc<{ groups: any[] }>("group/list").then((r) => r.groups.map((g: any) => g.name)),
  // TODO: add Zod schema for config/get
  getConfig: () => rpc<any>("config/get"),

  // ── Profiles ─────────────────────────────────────────────────────────────
  // TODO: add Zod schema for profile/list
  getProfiles: () => rpc<{ profiles: any[] }>("profile/list").then((r) => r.profiles),
  // TODO: add Zod schema for profile/create
  createProfile: (name: string, desc?: string) =>
    rpc<any>("profile/create", { name, description: desc }).then((r) => ({ ok: true, profile: r.profile })),
  // TODO: add Zod schema for profile/delete
  deleteProfile: (name: string) => rpc<any>("profile/delete", { name }).then(() => ({ ok: true, message: "Deleted" })),

  // ── Tools & MCP ──────────────────────────────────────────────────────────
  // TODO: add Zod schema for tools/list
  getTools: (dir?: string) => rpc<{ tools: any[] }>("tools/list", { projectRoot: dir }).then((r) => r.tools),
  // TODO: add Zod schema for mcp/attach-by-dir
  attachMcp: (dir: string, name: string, config: any) => rpc<any>("mcp/attach-by-dir", { dir, name, config }),
  // TODO: add Zod schema for mcp/detach-by-dir
  detachMcp: (dir: string, name: string) => rpc<any>("mcp/detach-by-dir", { dir, name }),

  // ── Skills & Recipes ─────────────────────────────────────────────────────
  getSkills: () => rpc<SkillListResponse>("skill/list", {} satisfies SkillListRequest).then((r) => r.skills),
  // TODO: add Zod schema for skill/save
  createSkill: (data: any) => rpc<any>("skill/save", data).then((r) => ({ ok: true, name: r.name })),
  // TODO: add Zod schema for skill/delete
  deleteSkill: (name: string, scope?: string) => rpc<any>("skill/delete", { name, scope }),
  // TODO: add Zod schema for recipe/list
  getRecipes: () => rpc<{ recipes: any[] }>("recipe/list").then((r) => r.recipes),
  // TODO: add Zod schema for recipe/delete
  deleteRecipe: (name: string, scope?: string) => rpc<any>("recipe/delete", { name, scope: scope ?? "global" }),

  // ── Agents, Runtimes & Flows ─────────────────────────────────────────────
  getAgents: () => rpc<AgentListResponse>("agent/list", {} satisfies AgentListRequest).then((r) => r.agents),
  // TODO: add Zod schema for runtime/list
  getRuntimes: () => rpc<{ runtimes: any[] }>("runtime/list").then((r) => r.runtimes),
  // TODO: add Zod schema for runtime/read
  getRuntimeDetail: (name: string) => rpc<any>("runtime/read", { name }).then((r) => r.runtime),
  // TODO: add Zod schema for agent/create
  createAgent: (data: any) => rpc<any>("agent/create", data).then((r) => ({ ok: true, name: r.name })),
  // TODO: add Zod schema for agent/update
  updateAgent: (name: string, data: any) => rpc<any>("agent/update", { ...data, name }),
  // TODO: add Zod schema for agent/delete
  deleteAgent: (name: string) => rpc<any>("agent/delete", { name }),
  getFlows: () => rpc<FlowListResponse>("flow/list", {} satisfies FlowListRequest).then((r) => r.flows),
  getFlowDetail: (name: string) =>
    rpc<FlowReadResponse>("flow/read", { name } satisfies FlowReadRequest).then((r) => {
      const flow = r.flow;
      return {
        name: flow.name,
        description: flow.description,
        edges: flow.edges,
        inputs: (flow as any).inputs,
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
  uploadInput: (opts: { name: string; role: string; content: string; contentEncoding?: "base64" | "utf-8" }) =>
    rpc<{ path: string }>("input/upload", opts as any),
  // TODO: add Zod schema for flow/create
  createFlow: (data: any) => rpc<any>("flow/create", data).then((r) => ({ ok: true, name: r.name })),
  // TODO: add Zod schema for flow/delete
  deleteFlow: (name: string) => rpc<any>("flow/delete", { name }),

  // ── Worktrees ────────────────────────────────────────────────────────────
  // TODO: add Zod schema for worktree/list
  getWorktrees: () => rpc<{ worktrees: any[] }>("worktree/list").then((r) => r.worktrees),
  // TODO: add Zod schema for worktree/diff
  worktreeDiff: (id: string) => rpc<any>("worktree/diff", { sessionId: id }),
  // TODO: add Zod schema for worktree/finish
  finishWorktree: (id: string, opts?: any) => rpc<any>("worktree/finish", { sessionId: id, ...(opts ?? {}) }),
  // TODO: add Zod schema for worktree/create-pr
  worktreeCreatePR: (id: string, opts?: any) => rpc<any>("worktree/create-pr", { sessionId: id, ...(opts ?? {}) }),
  // TODO: add Zod schema for worktree/cleanup
  cleanupWorktrees: () => rpc<any>("worktree/cleanup"),

  // ── Conductor ────────────────────────────────────────────────────────────
  // TODO: add Zod schema for learning/list
  getLearnings: () => rpc<{ learnings: any[] }>("learning/list").then((r) => r.learnings),
  // TODO: add Zod schema for learning/add
  recordLearning: (title: string, desc: string) => rpc<any>("learning/add", { title, description: desc }),

  // ── Memory ───────────────────────────────────────────────────────────────
  // TODO: add Zod schema for memory/list
  getMemories: (scope?: string) => rpc<{ memories: any[] }>("memory/list", { scope }).then((r) => r.memories),
  // TODO: add Zod schema for memory/recall
  recallMemory: (q: string) => rpc<{ results: any[] }>("memory/recall", { query: q }).then((r) => r.results),
  // TODO: add Zod schema for memory/add
  addMemory: (content: string, opts?: any) =>
    rpc<any>("memory/add", { content, ...opts }).then((r) => ({ ok: true, entry: r.memory })),
  // TODO: add Zod schema for memory/forget
  forgetMemory: (id: string) =>
    rpc<any>("memory/forget", { id }).then((r) => ({ ok: r.ok, message: r.ok ? "Forgotten" : "Not found" })),

  // ── Knowledge ────────────────────────────────────────────────────────────
  // TODO: add Zod schema for knowledge/ingest
  ingestKnowledge: (path: string, opts?: any) => rpc<any>("knowledge/ingest", { path, ...opts }),
  // TODO: add Zod schema for knowledge/search
  knowledgeSearch: (query: string, opts?: { types?: string[]; limit?: number }) =>
    rpc<{ results: any[] }>("knowledge/search", { query, ...opts }).then((r) => r.results),
  knowledgeStats: () => rpc<KnowledgeStatsResponse>("knowledge/stats", {} satisfies KnowledgeStatsRequest),
  // TODO: add Zod schema for knowledge/index
  knowledgeIndex: (repo?: string) => rpc<any>("knowledge/index", { repo }),
  // TODO: add Zod schema for knowledge/export
  knowledgeExport: (dir?: string) => rpc<any>("knowledge/export", { dir }),
  // TODO: add Zod schema for knowledge/import
  knowledgeImport: (dir?: string) => rpc<any>("knowledge/import", { dir }),
  codebaseMemoryStatus: () =>
    rpc<{ available: boolean; path: string | null; version: string | null; tools?: string[] }>(
      "knowledge/codebase/status",
    ),

  // ── Schedules ────────────────────────────────────────────────────────────
  getSchedules: () =>
    rpc<ScheduleListResponse>("schedule/list", {} satisfies ScheduleListRequest).then((r) => r.schedules),
  createSchedule: (data: ScheduleCreateRequest) =>
    rpc<ScheduleCreateResponse>("schedule/create", data).then((r) => ({ ok: true as const, schedule: r.schedule })),
  // TODO: add Zod schema for schedule/delete
  deleteSchedule: (id: string) =>
    rpc<any>("schedule/delete", { id }).then((r) => ({ ok: r.ok, message: r.ok ? "Deleted" : "Not found" })),
  // TODO: add Zod schema for schedule/enable
  enableSchedule: (id: string) => rpc<any>("schedule/enable", { id }).then(() => ({ ok: true })),
  // TODO: add Zod schema for schedule/disable
  disableSchedule: (id: string) => rpc<any>("schedule/disable", { id }).then(() => ({ ok: true })),

  // ── Compute ──────────────────────────────────────────────────────────────
  getCompute: () => rpc<ComputeListResponse>("compute/list", {} satisfies ComputeListRequest).then((r) => r.targets),
  createCompute: (data: ComputeCreateRequest) =>
    rpc<ComputeCreateResponse>("compute/create", data).then((r) => ({ ok: true as const, compute: r.compute })),
  getComputeDetail: (name: string) =>
    rpc<ComputeReadResponse>("compute/read", { name } satisfies ComputeReadRequest).then((r) => r.compute),
  // TODO: add Zod schema for compute/provision
  provisionCompute: (name: string) => rpc<any>("compute/provision", { name }),
  // TODO: add Zod schema for compute/start-instance
  startCompute: (name: string) => rpc<any>("compute/start-instance", { name }),
  // TODO: add Zod schema for compute/stop-instance
  stopCompute: (name: string) => rpc<any>("compute/stop-instance", { name }),
  // compute/destroy cascades infra removal + DB row removal.
  // TODO: add Zod schema for compute/destroy
  destroyCompute: (name: string) => rpc<any>("compute/destroy", { name }),
  // TODO: add Zod schema for metrics/snapshot
  getComputeSnapshot: (computeName?: string) =>
    rpc<{ snapshot: any }>("metrics/snapshot", computeName ? { computeName } : {}).then((r) => r.snapshot),
  // TODO: add Zod schema for compute/kill-process
  killProcess: (pid: string) => rpc<{ ok: boolean }>("compute/kill-process", { pid }),
  // TODO: add Zod schema for compute/docker-logs
  getDockerLogs: (container: string, tail?: number) =>
    rpc<{ logs: string }>("compute/docker-logs", { container, tail: tail ?? 100 }).then((r) => r.logs),
  // TODO: add Zod schema for compute/docker-action
  dockerAction: (container: string, action: "stop" | "restart") =>
    rpc<{ ok: boolean }>("compute/docker-action", { container, action }),

  // ── Compute Templates ────────────────────────────────────────────────────
  // TODO: add Zod schema for compute/template/list
  listComputeTemplates: () => rpc<{ templates: any[] }>("compute/template/list").then((r) => r.templates),

  // ── Compute / Runtime kinds (Wave 3) ─────────────────────────────────────
  listComputeKinds: () => rpc<{ kinds: string[] }>("compute/kinds"),
  listRuntimeKinds: () => rpc<{ kinds: string[] }>("runtime/kinds"),

  // ── Repo Map ─────────────────────────────────────────────────────────────
  // TODO: add Zod schema for repo-map/get
  getRepoMap: (dir?: string) => rpc<any>("repo-map/get", { dir }),

  // ── Filesystem (local mode only) ─────────────────────────────────────────
  // TODO: add Zod schema for fs/list-dir
  listDir: (path?: string) =>
    rpc<{
      cwd: string;
      parent: string | null;
      home: string;
      entries: { name: string; path: string; isGitRepo?: boolean }[];
    }>("fs/list-dir", path === undefined ? {} : { path }),
};
