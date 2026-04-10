/**
 * ArkClient — typed JSON-RPC 2.0 client for the Ark protocol.
 *
 * Sends requests with auto-incrementing IDs, tracks pending promises,
 * and routes server notifications to event listeners.
 */

import type { Transport } from "./transport.js";
import {
  createRequest, createNotification,
  isResponse, isError, isNotification,
  ARK_VERSION, RpcError,
  type RequestId, type JsonRpcMessage,
} from "./types.js";
import type {
  Session, Compute, Event, Message, AgentDefinition, FlowDefinition,
  SessionOpResult, ComputeSnapshot,
  Profile, ClaudeSession, ToolEntry, MemoryEntry, Schedule,
  ConversationTurn, SearchResult,
  SessionStartResult, SessionListParams, SessionListResult,
  SessionReadResult, SessionUpdateResult,
  SessionEventsResult, SessionMessagesResult, SessionSearchResult,
  SessionConversationResult, SessionSearchConversationResult,
  SessionOutputResult, SessionForkResult, SessionCloneResult,
  ComputeCreateResult, ComputeListResult, ComputeReadResult,
  ComputePingResult, ComputeCleanZombiesResult,
  AgentListResult, AgentReadResult, FlowListResult, FlowReadResult,
  SkillListResult, SkillReadResult,
  RecipeListResult, RecipeReadResult, RecipeUseResult,
  RuntimeListResult, RuntimeReadResult,
  SkillDefinition, RecipeDefinition, RuntimeDefinition,
  HistoryListResult, HistoryRefreshResult, HistoryIndexResult, HistorySearchResult,
  HistoryRebuildFtsResult, HistoryImportResult,
  MetricsSnapshotResult, CostsReadResult,
  MemoryListResult, MemoryRecallResult, MemoryForgetResult, MemoryAddResult, MemoryClearResult,
  ScheduleListResult, ScheduleCreateResult, ScheduleDeleteResult,
  ProfileListResult, ProfileCreateResult,
  ToolsListResult,
  GroupListResult, GroupCreateResult,
  ConfigReadResult,
  IndexStatsResult,
} from "../types/index.js";

export class ArkClient {
  private transport: Transport;
  private idCounter = 0;
  private pending = new Map<RequestId, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(data: any) => void>>();

  constructor(transport: Transport) {
    this.transport = transport;
    this.transport.onMessage((msg) => this.handleMessage(msg));
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
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.transport.send(createRequest(id, method, params));
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async initialize(opts?: { subscribe?: string[] }): Promise<{ server: { name: string; version: string } }> {
    const result = await this.rpc<{ server: { name: string; version: string } }>("initialize", {
      client: { name: "ark-client", version: ARK_VERSION },
      subscribe: opts?.subscribe ?? ["**"],
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

  async sessionDispatch(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/dispatch", { sessionId });
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
    const { results } = await this.rpc<SessionSearchConversationResult>("session/search-conversation", { sessionId, query });
    return results;
  }

  async worktreeFinish(sessionId: string, opts?: { noMerge?: boolean }): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("worktree/finish", { sessionId, ...opts });
  }

  async worktreeCreatePR(sessionId: string, opts?: { title?: string; body?: string; base?: string; draft?: boolean }): Promise<SessionOpResult & { pr_url?: string }> {
    return this.rpc("worktree/create-pr", { sessionId, ...opts });
  }

  async worktreeDiff(sessionId: string, opts?: { base?: string }): Promise<{
    ok: boolean; stat: string; diff: string; branch: string; baseBranch: string;
    filesChanged: number; insertions: number; deletions: number;
    modifiedSinceReview: string[]; message?: string;
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

  // ── Resources ───────────────────────────────────────────────────────────────

  async agentList(): Promise<AgentDefinition[]> {
    const { agents } = await this.rpc<AgentListResult>("agent/list");
    return agents;
  }

  async agentRead(name: string): Promise<AgentDefinition> {
    const { agent } = await this.rpc<AgentReadResult>("agent/read", { name });
    return agent;
  }

  async flowList(): Promise<FlowDefinition[]> {
    const { flows } = await this.rpc<FlowListResult>("flow/list");
    return flows;
  }

  async flowRead(name: string): Promise<FlowDefinition> {
    const { flow } = await this.rpc<FlowReadResult>("flow/read", { name });
    return flow;
  }

  async skillList(): Promise<SkillDefinition[]> {
    const { skills } = await this.rpc<SkillListResult>("skill/list");
    return skills;
  }

  async skillRead(name: string): Promise<SkillDefinition> {
    const { skill } = await this.rpc<SkillReadResult>("skill/read", { name });
    return skill;
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

  async computeList(): Promise<Compute[]> {
    const { targets } = await this.rpc<ComputeListResult>("compute/list");
    return targets;
  }

  async computeCreate(opts: Record<string, unknown>): Promise<Compute> {
    const { compute } = await this.rpc<ComputeCreateResult>("compute/create", opts);
    return compute;
  }

  async computeDelete(name: string): Promise<void> {
    await this.rpc("compute/delete", { name });
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

  async toolsDeleteItem(opts: { name: string; kind: string; source?: string; scope?: string; projectRoot?: string }): Promise<void> {
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

  async sessionSpawn(sessionId: string, opts: { task: string; agent?: string; model?: string; group_name?: string }): Promise<SessionOpResult & { sessionId?: string }> {
    return this.rpc<SessionOpResult & { sessionId?: string }>("session/spawn", { sessionId, ...opts });
  }

  async sessionFanOut(sessionId: string, tasks: Array<{ summary: string; agent?: string; flow?: string }>): Promise<{ ok: boolean; childIds?: string[]; message?: string }> {
    return this.rpc<{ ok: boolean; childIds?: string[]; message?: string }>("session/fan-out", { sessionId, tasks });
  }

  async sessionResume(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/resume", { sessionId });
  }

  async sessionPause(sessionId: string, reason?: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/pause", { sessionId, reason });
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

  async memoryAdd(content: string, opts?: { tags?: string[]; scope?: string; importance?: number }): Promise<MemoryEntry> {
    const { memory } = await this.rpc<MemoryAddResult>("memory/add", { content, ...opts });
    return memory;
  }

  async memoryClear(scope?: string): Promise<number> {
    const { count } = await this.rpc<MemoryClearResult>("memory/clear", { scope });
    return count;
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
