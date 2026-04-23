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
  SessionAttachCommandRequest,
  SessionAttachCommandResponse,
  SessionOutputRequest,
  SessionOutputResponse,
  SessionRecordingRequest,
  SessionRecordingResponse,
  SessionStdioRequest,
  SessionStdioResponse,
  SessionTranscriptRequest,
  SessionTranscriptResponse,
  SessionEventsRequest,
  SessionEventsResponse,
  SessionMessagesRequest,
  SessionMessagesResponse,
  SessionExportDataRequest,
  SessionExportDataResponse,
  SessionImportRequest,
  SessionImportResponse,
  SessionResumeRequest,
  SessionResumeResponse,
  SessionCloneRequest,
  SessionCloneResponse,
  SessionPauseResponse,
  SessionInterruptRequest,
  SessionInterruptResponse,
  SessionCompleteRequest,
  SessionCompleteResponse,
  SessionSpawnRequest,
  SessionSpawnResponse,
  SessionUnreadCountsResponse,
  SessionConversationRequest,
  SessionConversationResponse,
  MessageSendRequest,
  MessageSendResponse,
  MessageMarkReadRequest,
  MessageMarkReadResponse,
  GateApproveRequest,
  GateApproveResponse,
  GateRejectRequest,
  GateRejectResponse,
  ComputeListRequest,
  ComputeListResponse,
  ComputeCreateRequest,
  ComputeCreateResponse,
  ComputeReadRequest,
  ComputeReadResponse,
  ComputeCapabilitiesRequest,
  ComputeCapabilitiesResponse,
  ComputeProvisionRequest,
  ComputeProvisionResponse,
  ComputeStartInstanceRequest,
  ComputeStartInstanceResponse,
  ComputeStopInstanceRequest,
  ComputeStopInstanceResponse,
  ComputeDestroyRequest,
  ComputeDestroyResponse,
  ComputeKillProcessRequest,
  ComputeKillProcessResponse,
  ComputeDockerLogsRequest,
  ComputeDockerLogsResponse,
  ComputeDockerActionRequest,
  ComputeDockerActionResponse,
  ComputeTemplateListResponse,
  MetricsSnapshotRequest,
  MetricsSnapshotResponse,
  FlowListRequest,
  FlowListResponse,
  FlowReadRequest,
  FlowReadResponse,
  FlowCreateRequest,
  FlowCreateResponse,
  FlowDeleteRequest,
  FlowDeleteResponse,
  AgentListRequest,
  AgentListResponse,
  AgentCreateRequest,
  AgentCreateResponse,
  AgentUpdateRequest,
  AgentUpdateResponse,
  AgentDeleteRequest,
  AgentDeleteResponse,
  RuntimeListResponse,
  RuntimeReadRequest,
  RuntimeReadResponse,
  ModelListResponse,
  SkillListRequest,
  SkillListResponse,
  SkillSaveRequest,
  SkillSaveResponse,
  SkillDeleteRequest,
  SkillDeleteResponse,
  RecipeListResponse,
  RecipeDeleteRequest,
  RecipeDeleteResponse,
  ScheduleListRequest,
  ScheduleListResponse,
  ScheduleCreateRequest,
  ScheduleCreateResponse,
  ScheduleDeleteRequest,
  ScheduleDeleteResponse,
  ScheduleEnableRequest,
  ScheduleEnableResponse,
  ScheduleDisableRequest,
  ScheduleDisableResponse,
  CostsReadRequest,
  CostsReadResponse,
  CostsSessionRequest,
  CostsSessionResponse,
  CostExportRequest,
  CostExportResponse,
  SearchSessionsRequest,
  SearchSessionsResponse,
  SearchGlobalRequest,
  SearchGlobalResponse,
  HistoryListResponse,
  HistoryRefreshAndIndexResponse,
  HistoryRebuildFtsResponse,
  DashboardSummaryRequest,
  DashboardSummaryResponse,
  StatusGetResponse,
  DaemonStatusResponse,
  GroupListResponse,
  ConfigGetResponse,
  ProfileListResponse,
  ProfileCreateRequest,
  ProfileCreateResponse,
  ProfileDeleteRequest,
  ProfileDeleteResponse,
  ToolsListRequest,
  ToolsListResponse,
  McpAttachByDirRequest,
  McpAttachByDirResponse,
  McpDetachByDirRequest,
  McpDetachByDirResponse,
  TodoAddRequest,
  TodoAddResponse,
  TodoToggleRequest,
  TodoToggleResponse,
  TodoListRequest,
  TodoListResponse,
  TodoDeleteRequest,
  TodoDeleteResponse,
  VerifyRunRequest,
  VerifyRunResponse,
  LearningListResponse,
  LearningAddRequest,
  LearningAddResponse,
  MemoryListRequest,
  MemoryListResponse,
  MemoryRecallRequest,
  MemoryRecallResponse,
  MemoryAddRequest,
  MemoryAddResponse,
  MemoryForgetRequest,
  MemoryForgetResponse,
  KnowledgeStatsRequest,
  KnowledgeStatsResponse,
  KnowledgeIngestRequest,
  KnowledgeIngestResponse,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  KnowledgeIndexRequest,
  KnowledgeIndexResponse,
  KnowledgeExportRequest,
  KnowledgeExportResponse,
  KnowledgeImportRequest,
  KnowledgeImportResponse,
  WorktreeListResponse,
  WorktreeDiffRequest,
  WorktreeDiffResponse,
  WorktreeFinishRequest,
  WorktreeFinishResponse,
  WorktreeCreatePrRequest,
  WorktreeCreatePrResponse,
  WorktreeCleanupResponse,
  RepoMapGetRequest,
  RepoMapGetResponse,
  FsListDirRequest,
  FsListDirResponse,
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
  getSessions: (filters?: Partial<SessionListRequest> & { rootsOnly?: boolean }) =>
    rpc<SessionListResponse>("session/list", { limit: 200, ...(filters ?? {}) }).then((r) => r.sessions),
  /**
   * List the direct children of a session. Each row carries its own
   * `child_stats` rollup (nullable). Backed by `session/list_children`
   * which was added alongside the tree API.
   */
  getSessionChildren: (id: string) => rpc<{ sessions: any[] }>("session/list_children", { sessionId: id }),
  /**
   * Load the full recursive tree rooted at `id`. The server enforces max
   * depth 6 and rejects non-root ids. Returns `{ root: SessionWithChildren }`.
   */
  getSessionTree: (id: string) => rpc<{ root: any }>("session/tree", { sessionId: id }),
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
  getAttachCommand: (id: string) =>
    rpc<SessionAttachCommandResponse>("session/attach-command", {
      sessionId: id,
    } satisfies SessionAttachCommandRequest),

  // ── Sessions (extended) ──────────────────────────────────────────────────
  getOutput: (id: string) =>
    rpc<SessionOutputResponse>("session/output", { sessionId: id } satisfies SessionOutputRequest).then((r) => ({
      ok: true,
      output: r.output,
    })),
  getRecording: (id: string) =>
    rpc<SessionRecordingResponse>("session/recording", { sessionId: id } satisfies SessionRecordingRequest),
  getStdio: (id: string, opts?: { tail?: number }) =>
    rpc<SessionStdioResponse>("session/stdio", {
      sessionId: id,
      ...(opts?.tail ? { tail: opts.tail } : {}),
    } satisfies SessionStdioRequest),
  getTranscript: (id: string) =>
    rpc<SessionTranscriptResponse>("session/transcript", { sessionId: id } satisfies SessionTranscriptRequest),
  getEvents: (id: string) =>
    rpc<SessionEventsResponse>("session/events", { sessionId: id } satisfies SessionEventsRequest).then(
      (r) => r.events,
    ),
  getMessages: (id: string) =>
    rpc<SessionMessagesResponse>("session/messages", { sessionId: id } satisfies SessionMessagesRequest),
  exportSession: (id: string) =>
    rpc<SessionExportDataResponse>("session/export-data", { sessionId: id } satisfies SessionExportDataRequest),
  importSession: (data: SessionImportRequest) => rpc<SessionImportResponse>("session/import", data),
  restart: (id: string, opts?: { rewindToStage?: string }) =>
    rpc<SessionResumeResponse>("session/resume", {
      sessionId: id,
      ...(opts?.rewindToStage ? { rewindToStage: opts.rewindToStage } : {}),
    } satisfies SessionResumeRequest),
  // Flow stage list used by the Restart-from-stage dialog. `currentStage` is
  // the session's current pointer; `stages` is the full flow definition in
  // order. Typed inline because the handler's return shape isn't in
  // rpc-schemas.ts yet.
  getFlowStages: (id: string) =>
    rpc<{
      flow: string;
      currentStage: string | null;
      stages: Array<{ name: string; type: string; action?: string; agent?: string }>;
    }>("session/flowStages", { sessionId: id }),
  fork: (id: string, name?: string) =>
    rpc<SessionCloneResponse>("session/clone", { sessionId: id, name } satisfies SessionCloneRequest).then((r) => ({
      ok: true as const,
      sessionId: r.session?.id,
    })),
  send: (id: string, message: string) =>
    rpc<MessageSendResponse>("message/send", {
      sessionId: id,
      content: message,
    } satisfies MessageSendRequest),
  markRead: (id: string) =>
    rpc<MessageMarkReadResponse>("message/markRead", { sessionId: id } satisfies MessageMarkReadRequest),
  getUnreadCounts: () => rpc<SessionUnreadCountsResponse>("session/unread-counts").then((r) => r.counts),
  pause: (id: string, reason?: string) => rpc<SessionPauseResponse>("session/pause", { sessionId: id, reason }),
  interrupt: (id: string) =>
    rpc<SessionInterruptResponse>("session/interrupt", { sessionId: id } satisfies SessionInterruptRequest),
  complete: (id: string) =>
    rpc<SessionCompleteResponse>("session/complete", { sessionId: id } satisfies SessionCompleteRequest),
  spawnSubagent: (id: string, data: Omit<SessionSpawnRequest, "sessionId">) =>
    rpc<SessionSpawnResponse>("session/spawn", { sessionId: id, ...data }),
  gateApprove: (id: string) => rpc<GateApproveResponse>("gate/approve", { sessionId: id } satisfies GateApproveRequest),
  sessionReject: (id: string, reason: string) =>
    rpc<GateRejectResponse>("gate/reject", { sessionId: id, reason } satisfies GateRejectRequest),

  // ── Todos & Verification ─────────────────────────────────────────────────
  getTodos: (id: string) =>
    rpc<TodoListResponse>("todo/list", { sessionId: id } satisfies TodoListRequest).then((r) => r.todos),
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
  deleteTodo: (id: number) => rpc<TodoDeleteResponse>("todo/delete", { id } satisfies TodoDeleteRequest),
  runVerification: (id: string) => rpc<VerifyRunResponse>("verify/run", { sessionId: id } satisfies VerifyRunRequest),

  // ── Costs ────────────────────────────────────────────────────────────────
  getCosts: () =>
    rpc<CostsReadResponse>("costs/read", {} satisfies CostsReadRequest).then((r) => ({
      sessions: r.costs,
      total: r.total,
    })),
  getSessionCost: (id: string) =>
    rpc<CostsSessionResponse>("costs/session", { sessionId: id } satisfies CostsSessionRequest),
  exportCosts: (format: string) => rpc<CostExportResponse>("cost/export", { format } satisfies CostExportRequest),

  // ── Search ───────────────────────────────────────────────────────────────
  search: (q: string) => rpc<SearchSessionsResponse>("search/sessions", { query: q } satisfies SearchSessionsRequest),
  searchGlobal: (q: string) => rpc<SearchGlobalResponse>("search/global", { query: q } satisfies SearchGlobalRequest),

  // ── History (Claude Code transcripts) ────────────────────────────────────
  getClaudeSessions: () => rpc<HistoryListResponse>("history/list").then((r) => r.items),
  getConversation: (sessionId: string, limit = 50) =>
    rpc<SessionConversationResponse>("session/conversation", {
      sessionId,
      limit,
    } satisfies SessionConversationRequest).then((r) => r.turns || []),
  refreshHistory: () => rpc<HistoryRefreshAndIndexResponse>("history/refresh-and-index"),
  rebuildHistory: () => rpc<HistoryRebuildFtsResponse>("history/rebuild-fts"),

  // ── Dashboard ────────────────────────────────────────────────────────────
  getDashboardSummary: () => rpc<DashboardSummaryResponse>("dashboard/summary", {} satisfies DashboardSummaryRequest),

  // ── System ───────────────────────────────────────────────────────────────
  getStatus: () => rpc<StatusGetResponse>("status/get"),
  getDaemonStatus: () => rpc<DaemonStatusResponse>("daemon/status"),
  getGroups: () => rpc<GroupListResponse>("group/list").then((r) => r.groups.map((g) => g.name)),
  getConfig: () => rpc<ConfigGetResponse>("config/get"),

  // ── Profiles ─────────────────────────────────────────────────────────────
  getProfiles: () => rpc<ProfileListResponse>("profile/list").then((r) => r.profiles),
  createProfile: (name: string, desc?: string) =>
    rpc<ProfileCreateResponse>("profile/create", {
      name,
      description: desc,
    } satisfies ProfileCreateRequest).then((r) => ({ ok: true as const, profile: r.profile })),
  deleteProfile: (name: string) =>
    rpc<ProfileDeleteResponse>("profile/delete", { name } satisfies ProfileDeleteRequest).then(() => ({
      ok: true as const,
      message: "Deleted",
    })),

  // ── Tools & MCP ──────────────────────────────────────────────────────────
  getTools: (dir?: string) =>
    rpc<ToolsListResponse>("tools/list", { projectRoot: dir } satisfies ToolsListRequest).then((r) => r.tools),
  attachMcp: (dir: string, name: string, config: Record<string, unknown>) =>
    rpc<McpAttachByDirResponse>("mcp/attach-by-dir", { dir, name, config } satisfies McpAttachByDirRequest),
  detachMcp: (dir: string, name: string) =>
    rpc<McpDetachByDirResponse>("mcp/detach-by-dir", { dir, name } satisfies McpDetachByDirRequest),

  // ── Skills & Recipes ─────────────────────────────────────────────────────
  getSkills: () => rpc<SkillListResponse>("skill/list", {} satisfies SkillListRequest).then((r) => r.skills),
  createSkill: (data: SkillSaveRequest) =>
    rpc<SkillSaveResponse>("skill/save", data).then((r) => ({ ok: true as const, name: r.name })),
  deleteSkill: (name: string, scope?: string) =>
    rpc<SkillDeleteResponse>("skill/delete", { name, scope } satisfies SkillDeleteRequest),
  getRecipes: () => rpc<RecipeListResponse>("recipe/list").then((r) => r.recipes),
  deleteRecipe: (name: string, scope?: string) =>
    rpc<RecipeDeleteResponse>("recipe/delete", {
      name,
      scope: scope ?? "global",
    } satisfies RecipeDeleteRequest),

  // ── Agents, Runtimes & Flows ─────────────────────────────────────────────
  getAgents: () => rpc<AgentListResponse>("agent/list", {} satisfies AgentListRequest).then((r) => r.agents),
  getRuntimes: () => rpc<RuntimeListResponse>("runtime/list").then((r) => r.runtimes),
  getRuntimeDetail: (name: string) =>
    rpc<RuntimeReadResponse>("runtime/read", { name } satisfies RuntimeReadRequest).then((r) => r.runtime),
  getModels: () => rpc<ModelListResponse>("model/list").then((r) => r.models),
  createAgent: (data: AgentCreateRequest) =>
    rpc<AgentCreateResponse>("agent/create", data).then((r) => ({ ok: true as const, name: r.name })),
  updateAgent: (name: string, data: Omit<AgentUpdateRequest, "name">) =>
    rpc<AgentUpdateResponse>("agent/update", { ...data, name } satisfies AgentUpdateRequest),
  deleteAgent: (name: string) => rpc<AgentDeleteResponse>("agent/delete", { name } satisfies AgentDeleteRequest),
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
    rpc<{ locator: string }>("input/upload", opts as any),
  readInput: (locator: string) =>
    rpc<{
      filename: string;
      contentType: string;
      content: string;
      contentEncoding: "base64";
      size: number;
    }>("input/read", { locator }),
  createFlow: (data: FlowCreateRequest) =>
    rpc<FlowCreateResponse>("flow/create", data).then((r) => ({ ok: true as const, name: r.name })),
  deleteFlow: (name: string) => rpc<FlowDeleteResponse>("flow/delete", { name } satisfies FlowDeleteRequest),

  // ── Worktrees ────────────────────────────────────────────────────────────
  getWorktrees: () => rpc<WorktreeListResponse>("worktree/list").then((r) => r.worktrees),
  worktreeDiff: (id: string) =>
    rpc<WorktreeDiffResponse>("worktree/diff", { sessionId: id } satisfies WorktreeDiffRequest),
  finishWorktree: (id: string, opts?: Omit<WorktreeFinishRequest, "sessionId">) =>
    rpc<WorktreeFinishResponse>("worktree/finish", {
      sessionId: id,
      ...(opts ?? {}),
    } satisfies WorktreeFinishRequest),
  worktreeCreatePR: (id: string, opts?: Omit<WorktreeCreatePrRequest, "sessionId">) =>
    rpc<WorktreeCreatePrResponse>("worktree/create-pr", {
      sessionId: id,
      ...(opts ?? {}),
    } satisfies WorktreeCreatePrRequest),
  cleanupWorktrees: () => rpc<WorktreeCleanupResponse>("worktree/cleanup"),

  // ── Conductor ────────────────────────────────────────────────────────────
  getLearnings: () => rpc<LearningListResponse>("learning/list").then((r) => r.learnings),
  recordLearning: (title: string, desc: string) =>
    rpc<LearningAddResponse>("learning/add", { title, description: desc } satisfies LearningAddRequest),

  // ── Memory ───────────────────────────────────────────────────────────────
  getMemories: (scope?: string) =>
    rpc<MemoryListResponse>("memory/list", { scope } satisfies MemoryListRequest).then((r) => r.memories),
  recallMemory: (q: string) =>
    rpc<MemoryRecallResponse>("memory/recall", { query: q } satisfies MemoryRecallRequest).then((r) => r.results),
  addMemory: (content: string, opts?: Omit<MemoryAddRequest, "content">) =>
    rpc<MemoryAddResponse>("memory/add", { content, ...opts } satisfies MemoryAddRequest).then((r) => ({
      ok: true as const,
      entry: r.memory,
    })),
  forgetMemory: (id: string) =>
    rpc<MemoryForgetResponse>("memory/forget", { id } satisfies MemoryForgetRequest).then((r) => ({
      ok: r.ok,
      message: r.ok ? "Forgotten" : "Not found",
    })),

  // ── Knowledge ────────────────────────────────────────────────────────────
  ingestKnowledge: (path: string, opts?: Omit<KnowledgeIngestRequest, "path">) =>
    rpc<KnowledgeIngestResponse>("knowledge/ingest", { path, ...opts } satisfies KnowledgeIngestRequest),
  knowledgeSearch: (query: string, opts?: { types?: string[]; limit?: number }) =>
    rpc<KnowledgeSearchResponse>("knowledge/search", { query, ...opts } satisfies KnowledgeSearchRequest).then(
      (r) => r.results,
    ),
  knowledgeStats: () => rpc<KnowledgeStatsResponse>("knowledge/stats", {} satisfies KnowledgeStatsRequest),
  knowledgeIndex: (repo?: string) =>
    rpc<KnowledgeIndexResponse>("knowledge/index", { repo } satisfies KnowledgeIndexRequest),
  knowledgeExport: (dir?: string) =>
    rpc<KnowledgeExportResponse>("knowledge/export", { dir } satisfies KnowledgeExportRequest),
  knowledgeImport: (dir?: string) =>
    rpc<KnowledgeImportResponse>("knowledge/import", { dir } satisfies KnowledgeImportRequest),
  codebaseMemoryStatus: () =>
    rpc<{ available: boolean; path: string | null; version: string | null; tools?: string[] }>(
      "knowledge/codebase/status",
    ),

  // ── Schedules ────────────────────────────────────────────────────────────
  getSchedules: () =>
    rpc<ScheduleListResponse>("schedule/list", {} satisfies ScheduleListRequest).then((r) => r.schedules),
  createSchedule: (data: ScheduleCreateRequest) =>
    rpc<ScheduleCreateResponse>("schedule/create", data).then((r) => ({ ok: true as const, schedule: r.schedule })),
  deleteSchedule: (id: string) =>
    rpc<ScheduleDeleteResponse>("schedule/delete", { id } satisfies ScheduleDeleteRequest).then((r) => ({
      ok: r.ok,
      message: r.ok ? "Deleted" : "Not found",
    })),
  enableSchedule: (id: string) =>
    rpc<ScheduleEnableResponse>("schedule/enable", { id } satisfies ScheduleEnableRequest).then(() => ({
      ok: true as const,
    })),
  disableSchedule: (id: string) =>
    rpc<ScheduleDisableResponse>("schedule/disable", { id } satisfies ScheduleDisableRequest).then(() => ({
      ok: true as const,
    })),

  // ── Compute ──────────────────────────────────────────────────────────────
  getCompute: () => rpc<ComputeListResponse>("compute/list", {} satisfies ComputeListRequest).then((r) => r.targets),
  createCompute: (data: ComputeCreateRequest) =>
    rpc<ComputeCreateResponse>("compute/create", data).then((r) => ({ ok: true as const, compute: r.compute })),
  getComputeDetail: (name: string) =>
    rpc<ComputeReadResponse>("compute/read", { name } satisfies ComputeReadRequest).then((r) => r.compute),
  getComputeCapabilities: (name: string) =>
    rpc<ComputeCapabilitiesResponse>("compute/capabilities", { name } satisfies ComputeCapabilitiesRequest).then(
      (r) => r.capabilities,
    ),
  provisionCompute: (name: string) =>
    rpc<ComputeProvisionResponse>("compute/provision", { name } satisfies ComputeProvisionRequest),
  startCompute: (name: string) =>
    rpc<ComputeStartInstanceResponse>("compute/start-instance", { name } satisfies ComputeStartInstanceRequest),
  stopCompute: (name: string) =>
    rpc<ComputeStopInstanceResponse>("compute/stop-instance", { name } satisfies ComputeStopInstanceRequest),
  // compute/destroy cascades infra removal + DB row removal.
  destroyCompute: (name: string) =>
    rpc<ComputeDestroyResponse>("compute/destroy", { name } satisfies ComputeDestroyRequest),
  getComputeSnapshot: (computeName?: string) =>
    rpc<MetricsSnapshotResponse>(
      "metrics/snapshot",
      (computeName ? { computeName } : {}) satisfies MetricsSnapshotRequest,
    ).then((r) => r.snapshot),
  killProcess: (pid: string) =>
    rpc<ComputeKillProcessResponse>("compute/kill-process", { pid } satisfies ComputeKillProcessRequest),
  getDockerLogs: (container: string, tail?: number) =>
    rpc<ComputeDockerLogsResponse>("compute/docker-logs", {
      container,
      tail: tail ?? 100,
    } satisfies ComputeDockerLogsRequest).then((r) => r.logs),
  dockerAction: (container: string, action: "stop" | "restart") =>
    rpc<ComputeDockerActionResponse>("compute/docker-action", {
      container,
      action,
    } satisfies ComputeDockerActionRequest),

  // ── Compute Templates ────────────────────────────────────────────────────
  listComputeTemplates: () => rpc<ComputeTemplateListResponse>("compute/template/list").then((r) => r.templates),

  // ── Compute / Runtime kinds ──────────────────────────────────────────────
  listComputeKinds: () => rpc<{ kinds: string[] }>("compute/kinds"),
  listRuntimeKinds: () => rpc<{ kinds: string[] }>("runtime/kinds"),

  // ── Repo Map ─────────────────────────────────────────────────────────────
  getRepoMap: (dir?: string) => rpc<RepoMapGetResponse>("repo-map/get", { dir } satisfies RepoMapGetRequest),

  // ── Filesystem (local mode only) ─────────────────────────────────────────
  listDir: (path?: string) =>
    rpc<FsListDirResponse>("fs/list-dir", (path === undefined ? {} : { path }) satisfies FsListDirRequest),

  // ── Triggers / Connectors / Integrations (integration framework) ─────────
  getTriggers: (tenant?: string) => rpc<{ triggers: any[] }>("trigger/list", { tenant }).then((r) => r.triggers ?? []),
  getTriggerSources: () =>
    rpc<{ sources: Array<{ name: string; label: string; status: string; secretEnvVar: string }> }>(
      "trigger/sources",
    ).then((r) => r.sources ?? []),
  enableTrigger: (name: string, tenant?: string) => rpc<any>("trigger/enable", { name, tenant }),
  disableTrigger: (name: string, tenant?: string) => rpc<any>("trigger/disable", { name, tenant }),
  reloadTriggers: () => rpc<any>("trigger/reload"),
  testTrigger: (opts: { name: string; payload: unknown; tenant?: string; dryRun?: boolean }) =>
    rpc<{
      ok: boolean;
      fired: boolean;
      sessionId?: string;
      dryRun?: boolean;
      message?: string;
      event?: any;
    }>("trigger/test", opts as Record<string, unknown>),
  getConnectors: () => rpc<{ connectors: any[] }>("connectors/list").then((r) => r.connectors ?? []),
  testConnector: (name: string) =>
    rpc<{ name: string; reachable: boolean; details: string }>("connectors/test", { name }),
  getIntegrations: () => rpc<{ integrations: any[] }>("integrations/list").then((r) => r.integrations ?? []),

  // ── Secrets (tenant-scoped) ───────────────────────────────────────────────
  listSecrets: () =>
    rpc<{
      secrets: Array<{ tenant_id: string; name: string; description?: string; created_at: string; updated_at: string }>;
    }>("secret/list").then((r) => r.secrets ?? []),
  setSecret: (name: string, value: string, description?: string) =>
    rpc<{ ok: true }>("secret/set", { name, value, description }),
  deleteSecret: (name: string) => rpc<{ ok: boolean }>("secret/delete", { name }),
};
