/**
 * ArkClient -- typed JSON-RPC 2.0 client for the Ark protocol.
 *
 * Sends requests with auto-incrementing IDs, tracks pending promises,
 * and routes server notifications to event listeners.
 */

import type { Transport } from "./transport.js";
import type { ConnectionStatus } from "./transport.js";
import {
  createRequest,
  createNotification,
  isResponse,
  isError,
  isNotification,
  ARK_VERSION,
  RpcError,
  type RequestId,
  type JsonRpcMessage,
} from "./types.js";
import type {
  Session,
  Compute,
  Event,
  Message,
  AgentDefinition,
  FlowDefinition,
  SessionOpResult,
  ComputeSnapshot,
  Profile,
  ClaudeSession,
  ToolEntry,
  MemoryEntry,
  Schedule,
  ConversationTurn,
  SearchResult,
  SessionStartResult,
  SessionListParams,
  SessionListResult,
  SessionReadResult,
  SessionUpdateResult,
  SessionEventsResult,
  SessionMessagesResult,
  SessionSearchResult,
  SessionConversationResult,
  SessionSearchConversationResult,
  SessionOutputResult,
  SessionForkResult,
  SessionCloneResult,
  ComputeCreateResult,
  ComputeListResult,
  ComputeReadResult,
  ComputePingResult,
  ComputeCleanZombiesResult,
  AgentListResult,
  AgentReadResult,
  FlowListResult,
  FlowReadResult,
  SkillListResult,
  SkillReadResult,
  RecipeListResult,
  RecipeReadResult,
  RecipeUseResult,
  RuntimeListResult,
  RuntimeReadResult,
  SkillDefinition,
  RecipeDefinition,
  RuntimeDefinition,
  HistoryListResult,
  HistoryRefreshResult,
  HistoryIndexResult,
  HistorySearchResult,
  HistoryRebuildFtsResult,
  HistoryImportResult,
  MetricsSnapshotResult,
  CostsReadResult,
  MemoryListResult,
  MemoryRecallResult,
  MemoryForgetResult,
  MemoryAddResult,
  MemoryClearResult,
  ScheduleListResult,
  ScheduleCreateResult,
  ScheduleDeleteResult,
  ProfileListResult,
  ProfileCreateResult,
  ToolsListResult,
  GroupListResult,
  GroupCreateResult,
  ConfigReadResult,
  IndexStatsResult,
} from "../types/index.js";

/** Replay step returned by session/replay -- mirrors core/session/replay.ts */
export interface ReplayStep {
  index: number;
  timestamp: string;
  elapsed: string;
  type: string;
  stage: string | null;
  actor: string | null;
  summary: string;
  detail: string | null;
  data: Record<string, unknown> | null;
}

/**
 * Shape of a `SnapshotRef` as returned to RPC clients. Keeps the structural
 * contract independent of the `compute/` package so the protocol layer
 * doesn't leak compute internals.
 */
export interface SessionSnapshotRef {
  id: string;
  computeKind: string;
  sessionId: string;
  createdAt: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

export class ArkClient {
  private transport: Transport;
  private idCounter = 0;
  private pending = new Map<RequestId, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(data: any) => void>>();
  private _connectionStatus: ConnectionStatus = "connected";
  private _statusHandlers = new Set<(status: ConnectionStatus) => void>();
  private _lastSubscribe?: string[];

  constructor(transport: Transport) {
    this.transport = transport;
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  /** Current connection status. */
  get connectionStatus(): ConnectionStatus {
    return this._connectionStatus;
  }

  /** Subscribe to connection status changes. Returns an unsubscribe function. */
  onConnectionStatus(handler: (status: ConnectionStatus) => void): () => void {
    this._statusHandlers.add(handler);
    return () => {
      this._statusHandlers.delete(handler);
    };
  }

  /** Called by the transport layer (or externally) to update connection status. */
  setConnectionStatus(status: ConnectionStatus): void {
    if (status === this._connectionStatus) return;
    this._connectionStatus = status;
    for (const h of this._statusHandlers) h(status);
    // On reconnect, re-initialize subscriptions
    if (status === "connected" && this._lastSubscribe) {
      this.initialize({ subscribe: this._lastSubscribe }).catch(() => {});
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private handleMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg.result);
      }
      return;
    }

    if (isError(msg)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data));
      }
      return;
    }

    if (isNotification(msg)) {
      const handlers = this.listeners.get(msg.method);
      if (handlers) {
        for (const h of handlers) h(msg.params ?? {});
      }
      return;
    }
  }

  private rpc<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.transport.send(createRequest(id, method, params));
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async initialize(opts?: { subscribe?: string[] }): Promise<{ server: { name: string; version: string } }> {
    const subscribe = opts?.subscribe ?? ["**"];
    this._lastSubscribe = subscribe;
    const result = await this.rpc<{ server: { name: string; version: string } }>("initialize", {
      client: { name: "ark-client", version: ARK_VERSION },
      subscribe,
    });
    this.transport.send(createNotification("initialized"));
    return result;
  }

  // ── Notifications ───────────────────────────────────────────────────────────

  on(event: string, handler: (data: any) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: (data: any) => void): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  // ── Session Lifecycle ───────────────────────────────────────────────────────

  async sessionStart(opts: Record<string, unknown>): Promise<Session> {
    const { session } = await this.rpc<SessionStartResult>("session/start", opts);
    return session;
  }

  async sessionStop(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/stop", { sessionId });
  }

  async sessionAdvance(sessionId: string, force?: boolean): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/advance", { sessionId, force });
  }

  async sessionComplete(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/complete", { sessionId });
  }

  async sessionDelete(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/delete", { sessionId });
  }

  async sessionUndelete(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/undelete", { sessionId });
  }

  async sessionFork(sessionId: string, name?: string, groupName?: string): Promise<Session> {
    const { session } = await this.rpc<SessionForkResult>("session/fork", { sessionId, name, group_name: groupName });
    return session;
  }

  async sessionClone(sessionId: string, name?: string): Promise<Session> {
    const { session } = await this.rpc<SessionCloneResult>("session/clone", { sessionId, name });
    return session;
  }

  async sessionUpdate(sessionId: string, fields: Record<string, unknown>): Promise<Session> {
    const { session } = await this.rpc<SessionUpdateResult>("session/update", { sessionId, fields });
    return session;
  }

  async sessionList(filters?: SessionListParams & Record<string, unknown>): Promise<Session[]> {
    const { sessions } = await this.rpc<SessionListResult>("session/list", filters as Record<string, unknown>);
    return sessions;
  }

  async sessionRead(sessionId: string, include?: string[]): Promise<SessionReadResult> {
    return this.rpc<SessionReadResult>("session/read", { sessionId, include });
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  async sessionEvents(sessionId: string, limit?: number): Promise<Event[]> {
    const { events } = await this.rpc<SessionEventsResult>("session/events", { sessionId, limit });
    return events;
  }

  async sessionMessages(sessionId: string, limit?: number): Promise<Message[]> {
    const { messages } = await this.rpc<SessionMessagesResult>("session/messages", { sessionId, limit });
    return messages;
  }

  async sessionSearch(query: string): Promise<SearchResult[]> {
    const { results } = await this.rpc<SessionSearchResult>("session/search", { query });
    return results;
  }

  async sessionConversation(sessionId: string, limit?: number): Promise<ConversationTurn[]> {
    const { turns } = await this.rpc<SessionConversationResult>("session/conversation", { sessionId, limit });
    return turns;
  }

  async sessionSearchConversation(sessionId: string, query: string): Promise<SearchResult[]> {
    const { results } = await this.rpc<SessionSearchConversationResult>("session/search-conversation", {
      sessionId,
      query,
    });
    return results;
  }

  async worktreeFinish(sessionId: string, opts?: { noMerge?: boolean }): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("worktree/finish", { sessionId, ...opts });
  }

  async worktreeCreatePR(
    sessionId: string,
    opts?: { title?: string; body?: string; base?: string; draft?: boolean },
  ): Promise<SessionOpResult & { pr_url?: string }> {
    return this.rpc("worktree/create-pr", { sessionId, ...opts });
  }

  async worktreeDiff(
    sessionId: string,
    opts?: { base?: string },
  ): Promise<{
    ok: boolean;
    stat: string;
    diff: string;
    branch: string;
    baseBranch: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
    modifiedSinceReview: string[];
    message?: string;
  }> {
    return this.rpc("worktree/diff", { sessionId, ...opts });
  }

  // ── Messaging ───────────────────────────────────────────────────────────────

  async messageSend(sessionId: string, content: string): Promise<void> {
    await this.rpc("message/send", { sessionId, content });
  }

  async messageMarkRead(sessionId: string): Promise<void> {
    await this.rpc("message/markRead", { sessionId });
  }

  async gateApprove(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("gate/approve", { sessionId });
  }

  /** Reject a review gate with a reason; triggers a rework cycle. */
  async gateReject(sessionId: string, reason: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("gate/reject", { sessionId, reason });
  }

  /** Alias used by CLI + web UI -- matches the `sessionReject` naming scheme. */
  async sessionReject(sessionId: string, reason: string): Promise<SessionOpResult> {
    return this.gateReject(sessionId, reason);
  }

  // ── Resources ───────────────────────────────────────────────────────────────

  async agentList(): Promise<AgentDefinition[]> {
    const { agents } = await this.rpc<AgentListResult>("agent/list");
    return agents;
  }

  async agentRead(name: string): Promise<AgentDefinition> {
    const { agent } = await this.rpc<AgentReadResult>("agent/read", { name });
    return agent;
  }

  async agentSave(
    agent: Partial<AgentDefinition> & { name: string },
    opts?: { scope?: "global" | "project"; update?: boolean },
  ): Promise<{ ok: boolean; name: string; scope: string }> {
    const method = opts?.update ? "agent/update" : "agent/create";
    return this.rpc(method, { ...agent, scope: opts?.scope });
  }

  async agentDelete(name: string, scope?: "global" | "project"): Promise<{ ok: boolean }> {
    return this.rpc("agent/delete", { name, scope });
  }

  async flowList(): Promise<FlowDefinition[]> {
    const { flows } = await this.rpc<FlowListResult>("flow/list");
    return flows;
  }

  /**
   * Upload a session input file. Server persists through the configured
   * BlobStore (local disk or S3) and returns an opaque locator. Callers
   * put the returned locator into `sessionStart.inputs.files[role]`; the
   * server resolves it back to bytes on dispatch.
   */
  async inputUpload(opts: {
    name: string;
    role: string;
    content: string;
    contentEncoding?: "base64" | "utf-8";
  }): Promise<{ locator: string }> {
    return this.rpc<{ locator: string }>("input/upload", opts as unknown as Record<string, unknown>);
  }

  /** Read back a previously-uploaded input by locator. Tenant-enforced. */
  async inputRead(locator: string): Promise<{
    filename: string;
    contentType: string;
    content: string;
    contentEncoding: "base64";
    size: number;
  }> {
    return this.rpc("input/read", { locator });
  }

  async flowRead(name: string): Promise<FlowDefinition> {
    const { flow } = await this.rpc<FlowReadResult>("flow/read", { name });
    return flow;
  }

  async flowCreate(opts: {
    name: string;
    description?: string;
    stages: FlowDefinition["stages"];
    scope?: "global" | "project";
  }): Promise<{ ok: boolean; name: string }> {
    return this.rpc("flow/create", opts as unknown as Record<string, unknown>);
  }

  async flowDelete(name: string, scope?: "global" | "project"): Promise<{ ok: boolean }> {
    return this.rpc("flow/delete", { name, scope });
  }

  async skillList(): Promise<SkillDefinition[]> {
    const { skills } = await this.rpc<SkillListResult>("skill/list");
    return skills;
  }

  async skillRead(name: string): Promise<SkillDefinition> {
    const { skill } = await this.rpc<SkillReadResult>("skill/read", { name });
    return skill;
  }

  async skillSave(
    skill: Partial<SkillDefinition> & { name: string },
    opts?: { scope?: "global" | "project" },
  ): Promise<{ ok: boolean; name: string; scope: string }> {
    return this.rpc("skill/save", { ...skill, scope: opts?.scope });
  }

  async skillDelete(name: string, scope?: "global" | "project"): Promise<{ ok: boolean }> {
    return this.rpc("skill/delete", { name, scope });
  }

  async runtimeList(): Promise<RuntimeDefinition[]> {
    const { runtimes } = await this.rpc<RuntimeListResult>("runtime/list");
    return runtimes;
  }

  async runtimeRead(name: string): Promise<RuntimeDefinition> {
    const { runtime } = await this.rpc<RuntimeReadResult>("runtime/read", { name });
    return runtime;
  }

  async recipeList(): Promise<RecipeDefinition[]> {
    const { recipes } = await this.rpc<RecipeListResult>("recipe/list");
    return recipes;
  }

  async recipeRead(name: string): Promise<RecipeDefinition> {
    const { recipe } = await this.rpc<RecipeReadResult>("recipe/read", { name });
    return recipe;
  }

  async recipeUse(name: string, variables?: Record<string, string>): Promise<Session> {
    const { session } = await this.rpc<RecipeUseResult>("recipe/use", { name, variables });
    return session;
  }

  async recipeDelete(name: string, scope?: "global" | "project"): Promise<{ ok: boolean }> {
    return this.rpc("recipe/delete", { name, scope });
  }

  async computeList(opts?: { include?: "all" | "concrete" | "template" }): Promise<Compute[]> {
    const { targets } = await this.rpc<ComputeListResult>("compute/list", opts ?? {});
    return targets;
  }

  /**
   * Discover k8s contexts (and optionally namespaces) from the server's
   * kubeconfig. Powers interactive pickers in the CLI and web UI.
   */
  async k8sDiscover(opts?: { kubeconfig?: string; includeNamespaces?: boolean }): Promise<{
    contexts: Array<{ name: string; cluster?: string; user?: string }>;
    current: string;
    namespacesByContext?: Record<string, string[]>;
  }> {
    return this.rpc("k8s/discover", opts ?? {});
  }

  async computeCreate(opts: Record<string, unknown>): Promise<Compute> {
    const { compute } = await this.rpc<ComputeCreateResult>("compute/create", opts);
    return compute;
  }

  async computeUpdate(name: string, fields: Record<string, unknown>): Promise<void> {
    await this.rpc("compute/update", { name, fields });
  }

  async computeRead(name: string): Promise<Compute> {
    const { compute } = await this.rpc<ComputeReadResult>("compute/read", { name });
    return compute;
  }

  async computeProvision(name: string): Promise<void> {
    await this.rpc("compute/provision", { name });
  }

  async computeStopInstance(name: string): Promise<void> {
    await this.rpc("compute/stop-instance", { name });
  }

  async computeStartInstance(name: string): Promise<void> {
    await this.rpc("compute/start-instance", { name });
  }

  async computeDestroy(name: string): Promise<void> {
    await this.rpc("compute/destroy", { name });
  }

  async computeClean(name: string): Promise<void> {
    await this.rpc("compute/clean", { name });
  }

  async computeReboot(name: string): Promise<void> {
    await this.rpc("compute/reboot", { name });
  }

  async computePing(name: string): Promise<ComputePingResult> {
    return this.rpc<ComputePingResult>("compute/ping", { name });
  }

  async computeCleanZombies(): Promise<ComputeCleanZombiesResult> {
    return this.rpc<ComputeCleanZombiesResult>("compute/clean-zombies");
  }

  async computeTemplateList(): Promise<{
    templates: Array<{ name: string; description?: string; provider: string; config: Record<string, unknown> }>;
  }> {
    return this.rpc("compute/template/list");
  }

  async computeTemplateGet(
    name: string,
  ): Promise<{ name: string; description?: string; provider: string; config: Record<string, unknown> } | null> {
    return this.rpc("compute/template/get", { name });
  }

  async groupList(): Promise<Array<{ name: string; created_at: string }>> {
    const { groups } = await this.rpc<GroupListResult>("group/list");
    return groups;
  }

  async groupCreate(name: string): Promise<{ name: string; created_at: string }> {
    const { group } = await this.rpc<GroupCreateResult>("group/create", { name });
    return group;
  }

  async groupDelete(name: string): Promise<void> {
    await this.rpc("group/delete", { name });
  }

  // ── Config ──────────────────────────────────────────────────────────────────

  async configRead(): Promise<Record<string, unknown>> {
    const { config } = await this.rpc<ConfigReadResult>("config/read");
    return config;
  }

  async configWrite(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { config: updated } = await this.rpc<ConfigReadResult>("config/write", config);
    return updated;
  }

  async profileList(): Promise<ProfileListResult> {
    return this.rpc<ProfileListResult>("profile/list");
  }

  async profileSet(name: string): Promise<void> {
    await this.rpc("profile/set", { name });
  }

  // ── History ─────────────────────────────────────────────────────────────────

  async historyList(limit?: number): Promise<ClaudeSession[]> {
    const { items } = await this.rpc<HistoryListResult>("history/list", { limit });
    return items;
  }

  async historyImport(claudeSessionId: string, opts?: { name?: string; repo?: string }): Promise<Session> {
    const { session } = await this.rpc<HistoryImportResult>("history/import", { claudeSessionId, ...opts });
    return session;
  }

  async historyRefresh(): Promise<HistoryRefreshResult> {
    return this.rpc<HistoryRefreshResult>("history/refresh");
  }

  async historyIndex(): Promise<HistoryIndexResult> {
    return this.rpc<HistoryIndexResult>("history/index");
  }

  async historyRebuildFts(): Promise<HistoryRebuildFtsResult> {
    return this.rpc<HistoryRebuildFtsResult>("history/rebuild-fts");
  }

  async historyRefreshAndIndex(): Promise<HistoryRebuildFtsResult> {
    return this.rpc<HistoryRebuildFtsResult>("history/refresh-and-index");
  }

  async historySearch(query: string, limit?: number): Promise<SearchResult[]> {
    const { results } = await this.rpc<HistorySearchResult>("history/search", { query, limit });
    return results;
  }

  // ── Tools ───────────────────────────────────────────────────────────────────

  async toolsList(projectRoot?: string): Promise<ToolEntry[]> {
    const { tools } = await this.rpc<ToolsListResult>("tools/list", { projectRoot });
    return tools;
  }

  async toolsDelete(id: string): Promise<void> {
    await this.rpc("tools/delete", { id });
  }

  async toolsDeleteItem(opts: {
    name: string;
    kind: string;
    source?: string;
    scope?: string;
    projectRoot?: string;
  }): Promise<void> {
    await this.rpc("tools/delete", opts);
  }

  async toolsRead(opts: { name: string; kind: string; projectRoot?: string }): Promise<any> {
    return this.rpc("tools/read", opts);
  }

  async mcpAttach(sessionId: string, server: Record<string, unknown>): Promise<void> {
    await this.rpc("mcp/attach", { sessionId, server });
  }

  async mcpDetach(sessionId: string, serverName: string): Promise<void> {
    await this.rpc("mcp/detach", { sessionId, serverName });
  }

  // ── Metrics ─────────────────────────────────────────────────────────────────

  async metricsSnapshot(computeName?: string): Promise<ComputeSnapshot | null> {
    const { snapshot } = await this.rpc<MetricsSnapshotResult>("metrics/snapshot", { computeName });
    return snapshot;
  }

  async costsRead(): Promise<CostsReadResult> {
    return this.rpc<CostsReadResult>("costs/read");
  }

  async costsSummary(opts?: { groupBy?: string; tenantId?: string; since?: string; until?: string }): Promise<{
    summary: Array<{ key: string; cost: number; input_tokens: number; output_tokens: number; count: number }>;
    total: number;
  }> {
    return this.rpc("costs/summary", opts as Record<string, unknown>);
  }

  async costsTrend(opts?: { tenantId?: string; days?: number }): Promise<{
    trend: Array<{ date: string; cost: number }>;
  }> {
    return this.rpc("costs/trend", opts as Record<string, unknown>);
  }

  async costsSession(sessionId: string): Promise<{
    cost: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    total_tokens: number;
    records: Array<{
      id: number;
      session_id: string;
      tenant_id: string;
      model: string;
      provider: string;
      runtime: string | null;
      agent_role: string | null;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      cost_usd: number;
      source: string;
      created_at: string;
    }>;
  }> {
    return this.rpc("costs/session", { sessionId });
  }

  async costsRecord(opts: {
    sessionId: string;
    model: string;
    provider: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    tenantId?: string;
    runtime?: string;
    agentRole?: string;
    source?: string;
  }): Promise<{ ok: boolean }> {
    return this.rpc("costs/record", opts as Record<string, unknown>);
  }

  // ── Session extended ────────────────────────────────────────────────────────

  async sessionOutput(sessionId: string, lines?: number): Promise<string> {
    const { output } = await this.rpc<SessionOutputResult>("session/output", { sessionId, lines });
    return output;
  }

  async sessionHandoff(sessionId: string, agent: string, instructions?: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/handoff", { sessionId, agent, instructions });
  }

  async sessionJoin(sessionId: string, force?: boolean): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/join", { sessionId, force });
  }

  async sessionSpawn(
    sessionId: string,
    opts: { task: string; agent?: string; model?: string; group_name?: string },
  ): Promise<SessionOpResult & { sessionId?: string }> {
    return this.rpc<SessionOpResult & { sessionId?: string }>("session/spawn", { sessionId, ...opts });
  }

  async sessionFanOut(
    sessionId: string,
    tasks: Array<{ summary: string; agent?: string; flow?: string }>,
  ): Promise<{ ok: boolean; childIds?: string[]; message?: string }> {
    return this.rpc<{ ok: boolean; childIds?: string[]; message?: string }>("session/fan-out", { sessionId, tasks });
  }

  async sessionResume(sessionId: string, snapshotId?: string): Promise<SessionOpResult & { snapshotId?: string }> {
    return this.rpc<SessionOpResult & { snapshotId?: string }>("session/resume", { sessionId, snapshotId });
  }

  async sessionPause(
    sessionId: string,
    reason?: string,
  ): Promise<SessionOpResult & { snapshot?: SessionSnapshotRef | null; notSupported?: boolean }> {
    return this.rpc<SessionOpResult & { snapshot?: SessionSnapshotRef | null; notSupported?: boolean }>(
      "session/pause",
      { sessionId, reason },
    );
  }

  async sessionInterrupt(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/interrupt", { sessionId });
  }

  async sessionArchive(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/archive", { sessionId });
  }

  async sessionRestore(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/restore", { sessionId });
  }

  async sessionExport(sessionId: string, filePath?: string): Promise<{ ok: boolean; filePath?: string; data?: any }> {
    return this.rpc<{ ok: boolean; filePath?: string; data?: any }>("session/export", { sessionId, filePath });
  }

  async sessionReplay(sessionId: string): Promise<ReplayStep[]> {
    const { steps } = await this.rpc<{ steps: ReplayStep[] }>("session/replay", { sessionId });
    return steps;
  }

  // ── Memory ─────────────────────────────────────────────────────────────────

  async memoryList(scope?: string): Promise<MemoryEntry[]> {
    const { memories } = await this.rpc<MemoryListResult>("memory/list", { scope });
    return memories;
  }

  async memoryRecall(query: string, opts?: { scope?: string; limit?: number }): Promise<MemoryEntry[]> {
    const { results } = await this.rpc<MemoryRecallResult>("memory/recall", { query, ...opts });
    return results;
  }

  async memoryForget(id: string): Promise<boolean> {
    const { ok } = await this.rpc<MemoryForgetResult>("memory/forget", { id });
    return ok;
  }

  async memoryAdd(
    content: string,
    opts?: { tags?: string[]; scope?: string; importance?: number },
  ): Promise<MemoryEntry> {
    const { memory } = await this.rpc<MemoryAddResult>("memory/add", { content, ...opts });
    return memory;
  }

  async memoryClear(scope?: string): Promise<number> {
    const { count } = await this.rpc<MemoryClearResult>("memory/clear", { scope });
    return count;
  }

  // ── Knowledge ──────────────────────────────────────────────────────────────

  async knowledgeSearch(
    query: string,
    opts?: { types?: string[]; limit?: number },
  ): Promise<
    Array<{
      id: string;
      type: string;
      label: string;
      content: string | null;
      score: number;
      metadata: Record<string, unknown>;
    }>
  > {
    const { results } = await this.rpc<{ results: any[] }>("knowledge/search", { query, ...opts });
    return results;
  }

  async knowledgeStats(): Promise<{
    nodes: number;
    edges: number;
    by_node_type: Record<string, number>;
    by_edge_type: Record<string, number>;
  }> {
    return this.rpc("knowledge/stats");
  }

  async knowledgeIndex(
    repo?: string,
  ): Promise<{ ok: boolean; files?: number; symbols?: number; edges?: number; duration_ms?: number; error?: string }> {
    return this.rpc("knowledge/index", { repo });
  }

  async knowledgeExport(dir?: string): Promise<{ ok: boolean; exported?: number }> {
    return this.rpc("knowledge/export", { dir });
  }

  async knowledgeImport(dir?: string): Promise<{ ok: boolean; imported?: number }> {
    return this.rpc("knowledge/import", { dir });
  }

  // ── Evals ─────────────────────────────────────────────────────────────────

  async evalStats(agentRole?: string): Promise<{
    stats: {
      totalSessions: number;
      completionRate: number;
      avgDurationMs: number;
      avgCost: number;
      avgTurns: number;
      testPassRate: number;
      prRate: number;
    };
  }> {
    return this.rpc("eval/stats", { agentRole });
  }

  async evalDrift(
    agentRole?: string,
    recentDays?: number,
  ): Promise<{ drift: { completionRateDelta: number; avgCostDelta: number; avgTurnsDelta: number; alert: boolean } }> {
    return this.rpc("eval/drift", { agentRole, recentDays });
  }

  async evalList(
    agentRole?: string,
    limit?: number,
  ): Promise<{
    evals: Array<{
      agentRole: string;
      runtime: string;
      model: string;
      sessionId: string;
      metrics: {
        completed: boolean;
        testsPassed: boolean | null;
        prCreated: boolean;
        turnCount: number;
        durationMs: number;
        tokenCost: number;
        filesChanged: number;
        retryCount: number;
      };
      timestamp: string;
    }>;
  }> {
    return this.rpc("eval/list", { agentRole, limit });
  }

  // ── Profile extended ───────────────────────────────────────────────────────

  async profileCreate(name: string, description?: string): Promise<Profile> {
    const { profile } = await this.rpc<ProfileCreateResult>("profile/create", { name, description });
    return profile;
  }

  async profileDelete(name: string): Promise<void> {
    await this.rpc("profile/delete", { name });
  }

  // ── Schedule ───────────────────────────────────────────────────────────────

  async scheduleList(): Promise<Schedule[]> {
    const { schedules } = await this.rpc<ScheduleListResult>("schedule/list");
    return schedules;
  }

  async scheduleCreate(opts: Record<string, unknown>): Promise<Schedule> {
    const { schedule } = await this.rpc<ScheduleCreateResult>("schedule/create", opts);
    return schedule;
  }

  async scheduleDelete(id: string): Promise<boolean> {
    const { ok } = await this.rpc<ScheduleDeleteResult>("schedule/delete", { id });
    return ok;
  }

  async scheduleEnable(id: string): Promise<void> {
    await this.rpc("schedule/enable", { id });
  }

  async scheduleDisable(id: string): Promise<void> {
    await this.rpc("schedule/disable", { id });
  }

  // ── Triggers (unified webhook / schedule / poll / event) ───────────────────

  async triggerList(tenant?: string): Promise<{ triggers: any[] }> {
    return this.rpc("trigger/list", { tenant });
  }

  async triggerGet(name: string, tenant?: string): Promise<{ trigger: any }> {
    return this.rpc("trigger/get", { name, tenant });
  }

  async triggerEnable(name: string, tenant?: string): Promise<void> {
    await this.rpc("trigger/enable", { name, tenant });
  }

  async triggerDisable(name: string, tenant?: string): Promise<void> {
    await this.rpc("trigger/disable", { name, tenant });
  }

  async triggerReload(): Promise<void> {
    await this.rpc("trigger/reload");
  }

  async triggerSources(): Promise<{
    sources: Array<{ name: string; label: string; status: string; secretEnvVar: string }>;
  }> {
    return this.rpc("trigger/sources");
  }

  async triggerTest(opts: {
    name: string;
    payload: unknown;
    headers?: Record<string, string>;
    tenant?: string;
    dryRun?: boolean;
  }): Promise<{ ok: boolean; fired: boolean; sessionId?: string; dryRun?: boolean; message?: string; event?: any }> {
    return this.rpc("trigger/test", opts);
  }

  // ── Connectors (outbound half of the integration framework) ────────────────

  async connectorsList(): Promise<{
    connectors: Array<{
      name: string;
      label: string;
      kind: "mcp" | "rest" | "context";
      status: "full" | "scaffolded" | "stub";
      auth: { kind: string; envVar?: string; secretsKey?: string } | null;
      mcp: { configName?: string; configPath?: string | null; hasInline: boolean } | null;
      rest: { baseUrl?: string; endpoints?: string[] } | null;
      hasContext: boolean;
    }>;
  }> {
    return this.rpc("connectors/list");
  }

  async connectorsGet(name: string): Promise<{ connector: any }> {
    return this.rpc("connectors/get", { name });
  }

  async connectorsTest(name: string): Promise<{ name: string; reachable: boolean; details: string }> {
    return this.rpc("connectors/test", { name });
  }

  // ── Integrations (unified trigger + connector catalog) ─────────────────────

  async integrationsList(): Promise<{
    integrations: Array<{
      name: string;
      label: string;
      status: "full" | "scaffolded" | "stub";
      has_trigger: boolean;
      has_connector: boolean;
      trigger_kind: string | null;
      connector_kind: string | null;
      auth: { envVar?: string; triggerSecretEnvVar?: string } | null;
    }>;
  }> {
    return this.rpc("integrations/list");
  }

  // ── History extended ───────────────────────────────────────────────────────

  async indexStats(): Promise<IndexStatsResult> {
    return this.rpc<IndexStatsResult>("history/index-stats");
  }

  // ── Todos & Verification ───────────────────────────────────────────────────

  async todoList(sessionId: string): Promise<{ todos: any[] }> {
    return this.rpc("todo/list", { sessionId });
  }

  async todoAdd(sessionId: string, content: string): Promise<{ todo: any }> {
    return this.rpc("todo/add", { sessionId, content });
  }

  async todoToggle(id: number): Promise<{ todo: any }> {
    return this.rpc("todo/toggle", { id });
  }

  async todoDelete(id: number): Promise<{ ok: boolean }> {
    return this.rpc("todo/delete", { id });
  }

  async verifyRun(sessionId: string): Promise<any> {
    return this.rpc("verify/run", { sessionId });
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────

  async dashboardSummary(): Promise<{
    counts: Record<string, number>;
    costs: { total: number; today: number; week: number; month: number; byModel: Record<string, number>; budget: any };
    recentEvents: Array<{
      sessionId: string;
      sessionSummary: string | null;
      type: string;
      data: any;
      created_at: string;
    }>;
    topCostSessions: Array<{ sessionId: string; summary: string | null; model: string | null; cost: number }>;
    system: { conductor: boolean; router: boolean };
    activeCompute: number;
  }> {
    return this.rpc("dashboard/summary");
  }

  // ── Admin: tenants ─────────────────────────────────────────────────────────

  async adminTenantList(): Promise<
    Array<{ id: string; slug: string; name: string; status: string; created_at: string; updated_at: string }>
  > {
    const { tenants } = await this.rpc<{ tenants: any[] }>("admin/tenant/list");
    return tenants;
  }

  async adminTenantGet(id: string): Promise<{
    id: string;
    slug: string;
    name: string;
    status: string;
    created_at: string;
    updated_at: string;
  } | null> {
    try {
      const { tenant } = await this.rpc<{ tenant: any }>("admin/tenant/get", { id });
      return tenant;
    } catch (e) {
      if (e instanceof RpcError && e.code === -32002) return null;
      throw e;
    }
  }

  async adminTenantCreate(opts: { slug: string; name: string; status?: string }): Promise<any> {
    const { tenant } = await this.rpc<{ tenant: any }>("admin/tenant/create", opts as Record<string, unknown>);
    return tenant;
  }

  async adminTenantUpdate(opts: { id: string; slug?: string; name?: string; status?: string }): Promise<any> {
    const { tenant } = await this.rpc<{ tenant: any }>("admin/tenant/update", opts as Record<string, unknown>);
    return tenant;
  }

  async adminTenantSetStatus(id: string, status: string): Promise<any> {
    const { tenant } = await this.rpc<{ tenant: any }>("admin/tenant/set-status", { id, status });
    return tenant;
  }

  async adminTenantDelete(id: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/tenant/delete", { id });
    return ok;
  }

  // ── Admin: teams ───────────────────────────────────────────────────────────

  async adminTeamList(tenant_id: string): Promise<any[]> {
    const { teams } = await this.rpc<{ teams: any[] }>("admin/team/list", { tenant_id });
    return teams;
  }

  async adminTeamGet(id: string): Promise<any | null> {
    try {
      const { team } = await this.rpc<{ team: any }>("admin/team/get", { id });
      return team;
    } catch (e) {
      if (e instanceof RpcError && e.code === -32002) return null;
      throw e;
    }
  }

  async adminTeamCreate(opts: {
    tenant_id: string;
    slug: string;
    name: string;
    description?: string | null;
  }): Promise<any> {
    const { team } = await this.rpc<{ team: any }>("admin/team/create", opts as Record<string, unknown>);
    return team;
  }

  async adminTeamUpdate(opts: { id: string; slug?: string; name?: string; description?: string | null }): Promise<any> {
    const { team } = await this.rpc<{ team: any }>("admin/team/update", opts as Record<string, unknown>);
    return team;
  }

  async adminTeamDelete(id: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/team/delete", { id });
    return ok;
  }

  async adminTeamMembersList(team_id: string): Promise<
    Array<{
      id: string;
      user_id: string;
      team_id: string;
      role: "owner" | "admin" | "member" | "viewer";
      created_at: string;
      email: string;
      name?: string | null;
    }>
  > {
    const { members } = await this.rpc<{ members: any[] }>("admin/team/members/list", { team_id });
    return members;
  }

  async adminTeamMembersAdd(opts: {
    team_id: string;
    user_id?: string;
    email?: string;
    role?: "owner" | "admin" | "member" | "viewer";
  }): Promise<any> {
    const { membership } = await this.rpc<{ membership: any }>(
      "admin/team/members/add",
      opts as Record<string, unknown>,
    );
    return membership;
  }

  async adminTeamMembersRemove(opts: { team_id: string; user_id?: string; email?: string }): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/team/members/remove", opts as Record<string, unknown>);
    return ok;
  }

  async adminTeamMembersSetRole(opts: {
    team_id: string;
    user_id?: string;
    email?: string;
    role: "owner" | "admin" | "member" | "viewer";
  }): Promise<any> {
    const { membership } = await this.rpc<{ membership: any }>(
      "admin/team/members/set-role",
      opts as Record<string, unknown>,
    );
    return membership;
  }

  // ── Admin: users ───────────────────────────────────────────────────────────

  async adminUserList(): Promise<
    Array<{ id: string; email: string; name: string | null; created_at: string; updated_at: string }>
  > {
    const { users } = await this.rpc<{ users: any[] }>("admin/user/list");
    return users;
  }

  async adminUserGet(id: string): Promise<any | null> {
    try {
      const { user } = await this.rpc<{ user: any }>("admin/user/get", { id });
      return user;
    } catch (e) {
      if (e instanceof RpcError && e.code === -32002) return null;
      throw e;
    }
  }

  async adminUserCreate(opts: { email: string; name?: string | null }): Promise<any> {
    const { user } = await this.rpc<{ user: any }>("admin/user/create", opts as Record<string, unknown>);
    return user;
  }

  async adminUserUpsert(opts: { email: string; name?: string | null }): Promise<any> {
    const { user } = await this.rpc<{ user: any }>("admin/user/upsert", opts as Record<string, unknown>);
    return user;
  }

  async adminUserDelete(id: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/user/delete", { id });
    return ok;
  }

  // ── Secrets ────────────────────────────────────────────────────────────────

  async secretList(): Promise<
    Array<{
      tenant_id: string;
      name: string;
      description?: string | null;
      created_at?: string | null;
      updated_at?: string | null;
    }>
  > {
    const { secrets } = await this.rpc<{ secrets: any[] }>("secret/list");
    return secrets;
  }

  async secretGet(name: string): Promise<string | null> {
    const { value } = await this.rpc<{ value: string | null }>("secret/get", { name });
    return value;
  }

  async secretSet(name: string, value: string, description?: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("secret/set", { name, value, description });
    return ok;
  }

  async secretDelete(name: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("secret/delete", { name });
    return ok;
  }

  // --- BEGIN agent-B: tenant policy + api key methods ---

  async tenantPolicyList(): Promise<
    Array<{
      tenant_id: string;
      allowed_providers: string[];
      default_provider: string;
      max_concurrent_sessions: number;
      max_cost_per_day_usd: number | null;
      compute_pools: Array<{
        pool_name: string;
        provider: string;
        min: number;
        max: number;
        config: Record<string, unknown>;
      }>;
      router_enabled: boolean | null;
      router_required: boolean;
      router_policy: string | null;
      auto_index: boolean | null;
      auto_index_required: boolean;
      tensorzero_enabled: boolean | null;
      allowed_k8s_contexts: string[];
    }>
  > {
    const { policies } = await this.rpc<{ policies: any[] }>("admin/tenant/policy/list");
    return policies;
  }

  async tenantPolicyGet(tenantId: string): Promise<any | null> {
    const { policy } = await this.rpc<{ policy: any | null }>("admin/tenant/policy/get", { tenant_id: tenantId });
    return policy;
  }

  async tenantPolicySet(opts: {
    tenant_id: string;
    allowed_providers?: string[];
    default_provider?: string;
    max_concurrent_sessions?: number;
    max_cost_per_day_usd?: number | null;
    compute_pools?: Array<{
      pool_name: string;
      provider: string;
      min: number;
      max: number;
      config: Record<string, unknown>;
    }>;
    router_enabled?: boolean | null;
    router_required?: boolean;
    router_policy?: string | null;
    auto_index?: boolean | null;
    auto_index_required?: boolean;
    tensorzero_enabled?: boolean | null;
    allowed_k8s_contexts?: string[];
  }): Promise<any> {
    const { policy } = await this.rpc<{ policy: any }>(
      "admin/tenant/policy/set",
      opts as unknown as Record<string, unknown>,
    );
    return policy;
  }

  async tenantPolicyDelete(tenantId: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/tenant/policy/delete", { tenant_id: tenantId });
    return ok;
  }

  async apiKeyList(tenantId: string): Promise<
    Array<{
      id: string;
      tenant_id: string;
      name: string;
      role: "admin" | "member" | "viewer";
      created_at: string;
      last_used_at: string | null;
      expires_at: string | null;
    }>
  > {
    const { keys } = await this.rpc<{ keys: any[] }>("admin/apikey/list", { tenant_id: tenantId });
    return keys;
  }

  async apiKeyCreate(opts: {
    tenant_id: string;
    name: string;
    role?: "admin" | "member" | "viewer";
    expires_at?: string;
  }): Promise<{
    id: string;
    key: string;
    tenant_id: string;
    name: string;
    role: "admin" | "member" | "viewer";
    expires_at: string | null;
  }> {
    return this.rpc("admin/apikey/create", opts as unknown as Record<string, unknown>);
  }

  async apiKeyRevoke(id: string, tenantId?: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/apikey/revoke", {
      id,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    });
    return ok;
  }

  async apiKeyRotate(id: string, tenantId?: string): Promise<{ ok: boolean; key: string }> {
    return this.rpc<{ ok: boolean; key: string }>("admin/apikey/rotate", {
      id,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    });
  }

  // --- END agent-B ---

  // --- BEGIN agent-C: resource CRUD methods ---

  /**
   * Create a new agent from a full YAML string. The daemon parses the YAML,
   * validates it, and writes it to the resource store. Scope defaults to
   * `global` unless `project` is requested (and a project root resolves).
   */
  async agentCreate(opts: {
    name: string;
    yaml: string;
    scope?: "global" | "project";
  }): Promise<{ ok: boolean; name: string; scope: string }> {
    return this.rpc("agent/create", opts as unknown as Record<string, unknown>);
  }

  /**
   * Overwrite an existing agent's YAML. Returns a 404-equivalent error if
   * the agent doesn't exist; refuses to edit builtin agents (copy first).
   */
  async agentEdit(opts: {
    name: string;
    yaml: string;
    scope?: "global" | "project";
  }): Promise<{ ok: boolean; name: string; scope: string }> {
    return this.rpc("agent/edit", opts as unknown as Record<string, unknown>);
  }

  /**
   * Duplicate an agent under a new name. Source may be any scope (including
   * builtin); destination is written at the requested scope.
   */
  async agentCopy(opts: {
    from: string;
    to: string;
    scope?: "global" | "project";
  }): Promise<{ ok: boolean; name: string; scope: string }> {
    return this.rpc("agent/copy", opts as unknown as Record<string, unknown>);
  }

  // `agentDelete` already exists on this class (legacy shape) and hits the
  // same `agent/delete` RPC method our new handler responds to. Re-adding
  // it would collide as a duplicate class member, so we reuse it.

  /**
   * Create a new skill from a full YAML string. Same shape as `agentCreate`.
   */
  async skillCreate(opts: {
    name: string;
    yaml: string;
    scope?: "global" | "project";
  }): Promise<{ ok: boolean; name: string; scope: string }> {
    return this.rpc("skill/create", opts as unknown as Record<string, unknown>);
  }

  // `skillDelete` already exists on this class and hits the same `skill/delete`
  // RPC method our new handler responds to.

  /**
   * Create a new recipe from a full YAML string. Requires a non-empty
   * `flow` field in the YAML.
   */
  async recipeCreate(opts: {
    name: string;
    yaml: string;
    scope?: "global" | "project";
  }): Promise<{ ok: boolean; name: string; scope: string }> {
    return this.rpc("recipe/create", opts as unknown as Record<string, unknown>);
  }

  // `recipeDelete` already exists on this class and hits the same
  // `recipe/delete` RPC method our new handler responds to.

  // --- END agent-C ---

  // --- BEGIN agent-E: conductor + sage + costs methods ---

  async conductorStatus(): Promise<{ running: boolean; port: number; pid?: number }> {
    return this.rpc("conductor/status");
  }

  async conductorLearnings(): Promise<{
    learnings: Array<{
      id: string;
      title: string;
      description: string;
      recurrence: number;
      promoted: boolean;
      lastSeen: string;
    }>;
  }> {
    return this.rpc("conductor/learnings");
  }

  async conductorLearn(opts: { title: string; description?: string }): Promise<{
    ok: boolean;
    learning: {
      id: string;
      title: string;
      description: string;
      recurrence: number;
      promoted: boolean;
      lastSeen: string;
    };
  }> {
    return this.rpc("conductor/learn", opts as Record<string, unknown>);
  }

  async conductorBridge(): Promise<{ ok: boolean; running: boolean; message?: string }> {
    return this.rpc("conductor/bridge");
  }

  async conductorNotify(message: string): Promise<{ ok: boolean; message?: string }> {
    return this.rpc("conductor/notify", { message });
  }

  async sageContext(opts: { analysisId: string; sageUrl?: string }): Promise<{
    analysisId: string;
    baseUrl: string;
    summary: string | null;
    streamCount: number;
    taskCount: number;
    streams: Array<{ repo: string; branch: string | null; tasks: Array<{ title: string }> }>;
  }> {
    return this.rpc("sage/context", opts as Record<string, unknown>);
  }

  async sageAnalyze(opts: {
    analysisId: string;
    sageUrl?: string;
    compute?: string;
    runtime?: string;
    repo?: string;
  }): Promise<{
    ok: boolean;
    sessionId: string;
    analysisId: string;
    streamCount: number;
    taskCount: number;
    message?: string;
  }> {
    return this.rpc("sage/analyze", opts as Record<string, unknown>);
  }

  async costsSync(): Promise<{ ok: boolean; synced: number; skipped: number }> {
    return this.rpc("costs/sync");
  }

  async costsExport(opts?: { limit?: number }): Promise<{
    total: number;
    rows: Array<{
      sessionId: string;
      summary: string | null;
      model: string | null;
      cost: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
    }>;
  }> {
    return this.rpc("costs/export", (opts ?? {}) as Record<string, unknown>);
  }

  // --- END agent-E ---

  // --- BEGIN agent-D: knowledge + code-intel + workspace methods ---

  /** Store a new memory node in the knowledge graph. Tenant-scoped. */
  async knowledgeRemember(opts: {
    content: string;
    tags?: string[];
    importance?: number;
    scope?: string;
  }): Promise<{ ok: boolean; id: string }> {
    return this.rpc("knowledge/remember", opts as Record<string, unknown>);
  }

  /** Search memory + learning nodes. Tenant-scoped. */
  async knowledgeRecall(
    query: string,
    opts?: { limit?: number },
  ): Promise<{
    results: Array<{
      id: string;
      type: string;
      label: string;
      content: string | null;
      score: number;
      metadata: Record<string, unknown>;
    }>;
  }> {
    return this.rpc("knowledge/recall", { query, ...(opts ?? {}) });
  }

  // ── code-intel ─────────────────────────────────────────────────────────

  async codeIntelHealth(): Promise<{
    schemaVersion: number;
    pending: number;
    deploymentMode: string;
    storeBackend: string;
    tenantCount: number;
    defaultTenantRepoCount: number;
    featureCodeIntelV2: boolean;
  }> {
    return this.rpc("code-intel/health");
  }

  async codeIntelMigrationStatus(): Promise<{
    currentVersion: number;
    pending: Array<{ version: number; name: string }>;
  }> {
    return this.rpc("code-intel/migration-status");
  }

  async codeIntelMigrate(opts?: { to?: number }): Promise<{ ok: boolean; currentVersion: number }> {
    return this.rpc("code-intel/migrate", (opts ?? {}) as Record<string, unknown>);
  }

  async codeIntelReset(opts: { confirm: true }): Promise<{ ok: boolean }> {
    return this.rpc("code-intel/reset", opts as Record<string, unknown>);
  }

  async codeIntelTenantList(): Promise<{
    tenants: Array<{ id: string; slug: string; name: string; created_at: string }>;
  }> {
    return this.rpc("code-intel/tenant/list");
  }

  async codeIntelRepoAdd(opts: {
    repoUrl: string;
    name?: string;
    defaultBranch?: string;
    localPath?: string | null;
  }): Promise<{ repo: any; created: boolean }> {
    return this.rpc("code-intel/repo/add", opts as Record<string, unknown>);
  }

  async codeIntelRepoList(): Promise<{
    repos: Array<{
      id: string;
      tenant_id: string;
      repo_url: string;
      name: string;
      default_branch: string;
      primary_language: string | null;
      local_path: string | null;
      config: Record<string, unknown>;
      created_at: string;
    }>;
  }> {
    return this.rpc("code-intel/repo/list");
  }

  async codeIntelReindex(opts?: { repoId?: string; extractors?: string[] }): Promise<{
    run: {
      id: string;
      status: string;
      tenant_id: string;
      repo_id: string;
      branch: string;
      started_at: string;
      finished_at: string | null;
      extractor_counts: Record<string, number>;
    };
  }> {
    return this.rpc("code-intel/reindex", (opts ?? {}) as Record<string, unknown>);
  }

  async codeIntelSearch(
    query: string,
    opts?: { limit?: number },
  ): Promise<{
    hits: Array<{
      chunk_id: string;
      chunk_kind: string;
      content_preview: string;
      [key: string]: unknown;
    }>;
  }> {
    return this.rpc("code-intel/search", { query, ...(opts ?? {}) });
  }

  async codeIntelGetContext(opts: { subject: string; repoId?: string }): Promise<{ context: any }> {
    return this.rpc("code-intel/get-context", opts as Record<string, unknown>);
  }

  // ── workspace ──────────────────────────────────────────────────────────

  async workspaceList(): Promise<{
    workspaces: Array<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      tenant_id: string;
      created_at: string;
      repo_count: number;
    }>;
  }> {
    return this.rpc("workspace/list");
  }

  async workspaceGet(slug: string): Promise<{
    workspace: {
      id: string;
      slug: string;
      name: string;
      description: string | null;
      tenant_id: string;
      created_at: string;
      repos: any[];
    };
  }> {
    return this.rpc("workspace/get", { slug });
  }

  async workspaceCreate(opts: {
    slug: string;
    name?: string;
    description?: string | null;
  }): Promise<{ workspace: any; created: boolean }> {
    return this.rpc("workspace/create", opts as Record<string, unknown>);
  }

  async workspaceDelete(opts: { slug: string; force?: boolean }): Promise<{ ok: boolean }> {
    return this.rpc("workspace/delete", opts as Record<string, unknown>);
  }

  async workspaceStatus(slug: string): Promise<{
    status: {
      id: string;
      slug: string;
      name: string;
      repo_count: number;
      repos: Array<{ id: string; name: string; repo_url: string }>;
    };
  }> {
    return this.rpc("workspace/status", { slug });
  }

  async workspaceAddRepo(opts: {
    slug: string;
    repo: string;
  }): Promise<{ ok: boolean; repo_id: string; workspace_id: string }> {
    return this.rpc("workspace/add-repo", opts as Record<string, unknown>);
  }

  async workspaceRemoveRepo(opts: { slug: string; repo: string }): Promise<{ ok: boolean; detached: boolean }> {
    return this.rpc("workspace/remove-repo", opts as Record<string, unknown>);
  }

  // --- END agent-D ---

  // --- BEGIN agent-F: blob secrets + tenant auth methods ---

  /** List blob-secret names for the current tenant. Never returns contents. */
  async secretBlobList(): Promise<string[]> {
    const { blobs } = await this.rpc<{ blobs: string[] }>("secret/blob/list");
    return blobs;
  }

  /**
   * Fetch every file in a blob. Files are returned base64-encoded so the
   * wire format is binary-safe; callers decode locally when writing to disk.
   */
  async secretBlobGet(name: string): Promise<{ files: Record<string, string>; encoding: "base64" } | null> {
    const { blob } = await this.rpc<{
      blob: { files: Record<string, string>; encoding: "base64" } | null;
    }>("secret/blob/get", { name });
    return blob;
  }

  /**
   * Create-or-replace a blob. Files default to base64-encoded values; pass
   * `encoding: "utf-8"` to let the server TextEncoder them server-side
   * (convenient for tests dealing with plaintext payloads).
   */
  async secretBlobSet(
    name: string,
    files: Record<string, string>,
    opts?: { encoding?: "base64" | "utf-8" },
  ): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("secret/blob/set", {
      name,
      files,
      encoding: opts?.encoding ?? "base64",
    });
    return ok;
  }

  /** Delete a blob. Returns true when a blob was actually removed. */
  async secretBlobDelete(name: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("secret/blob/delete", { name });
    return ok;
  }

  /** Get the current Claude auth binding for a tenant (or null if none). */
  async tenantAuthGet(tenantId: string): Promise<{
    tenant_id: string;
    kind: "api_key" | "subscription_blob";
    secret_ref: string;
    created_at: string;
    updated_at: string;
  } | null> {
    const { auth } = await this.rpc<{ auth: any | null }>("admin/tenant/auth/get", { tenant_id: tenantId });
    return auth;
  }

  /**
   * Set the Claude auth binding. `kind: "api_key"` points at a string
   * secret (the value becomes `ANTHROPIC_API_KEY` at dispatch).
   * `kind: "subscription_blob"` points at a blob (materialized into a
   * per-session k8s Secret at `/root/.claude`).
   */
  async tenantAuthSet(tenantId: string, kind: "api_key" | "subscription_blob", secretRef: string): Promise<any> {
    const { auth } = await this.rpc<{ auth: any }>("admin/tenant/auth/set", {
      tenant_id: tenantId,
      kind,
      secret_ref: secretRef,
    });
    return auth;
  }

  /** Clear the Claude auth binding. Idempotent; returns true when a row was removed. */
  async tenantAuthClear(tenantId: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/tenant/auth/clear", { tenant_id: tenantId });
    return ok;
  }

  // --- END agent-F ---

  // --- BEGIN agent-G: cluster + tenant compute config methods ---

  /**
   * List the effective cluster list for the current tenant. Returns each
   * cluster's name / kind / apiEndpoint / defaultNamespace (auth blocks are
   * never surfaced over the wire).
   */
  async clusterList(): Promise<
    Array<{
      name: string;
      kind: "k8s" | "k8s-kata";
      apiEndpoint: string;
      defaultNamespace?: string;
    }>
  > {
    const { clusters } = await this.rpc<{
      clusters: Array<{
        name: string;
        kind: "k8s" | "k8s-kata";
        apiEndpoint: string;
        defaultNamespace?: string;
      }>;
    }>("cluster/list");
    return clusters;
  }

  /** Fetch a tenant's compute-config YAML blob (admin only). */
  async tenantComputeConfigGet(tenantId: string): Promise<string | null> {
    const { yaml } = await this.rpc<{ yaml: string | null }>("admin/tenant/config/get-compute", {
      tenant_id: tenantId,
    });
    return yaml;
  }

  /**
   * Write a tenant's compute-config YAML blob (admin only). The server
   * validates the YAML shape before persisting.
   */
  async tenantComputeConfigSet(tenantId: string, yaml: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/tenant/config/set-compute", {
      tenant_id: tenantId,
      yaml,
    });
    return ok;
  }

  /** Clear a tenant's compute-config YAML blob (admin only). */
  async tenantComputeConfigClear(tenantId: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/tenant/config/clear-compute", {
      tenant_id: tenantId,
    });
    return ok;
  }

  // --- END agent-G ---

  // ── Teardown ────────────────────────────────────────────────────────────────

  close(): void {
    const err = new Error("ArkClient closed");
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
    this.listeners.clear();
    this.transport.close();
  }
}
