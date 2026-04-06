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
  type RequestId, type JsonRpcMessage,
} from "./types.js";

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
        const err = new Error(msg.error.message);
        (err as any).code = msg.error.code;
        (err as any).data = msg.error.data;
        p.reject(err);
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

  private rpc(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
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
    const result = await this.rpc("initialize", {
      client: { name: "ark-client", version: "0.8.0" },
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

  async sessionStart(opts: { summary: string; repo: string; flow?: string; [key: string]: unknown }): Promise<any> {
    const { session } = await this.rpc("session/start", opts as Record<string, unknown>);
    return session;
  }

  async sessionDispatch(sessionId: string): Promise<any> {
    return this.rpc("session/dispatch", { sessionId });
  }

  async sessionStop(sessionId: string): Promise<void> {
    await this.rpc("session/stop", { sessionId });
  }

  async sessionAdvance(sessionId: string, force?: boolean): Promise<any> {
    return this.rpc("session/advance", { sessionId, force });
  }

  async sessionComplete(sessionId: string): Promise<void> {
    await this.rpc("session/complete", { sessionId });
  }

  async sessionDelete(sessionId: string): Promise<void> {
    await this.rpc("session/delete", { sessionId });
  }

  async sessionUndelete(sessionId: string): Promise<any> {
    return this.rpc("session/undelete", { sessionId });
  }

  async sessionFork(sessionId: string, name?: string, groupName?: string): Promise<any> {
    const { session } = await this.rpc("session/fork", { sessionId, name, group_name: groupName });
    return session;
  }

  async sessionClone(sessionId: string, name?: string): Promise<any> {
    const { session } = await this.rpc("session/clone", { sessionId, name });
    return session;
  }

  async sessionUpdate(sessionId: string, fields: Record<string, unknown>): Promise<any> {
    const { session } = await this.rpc("session/update", { sessionId, fields });
    return session;
  }

  async sessionList(filters?: Record<string, unknown>): Promise<any[]> {
    const { sessions } = await this.rpc("session/list", filters);
    return sessions;
  }

  async sessionRead(sessionId: string, include?: string[]): Promise<{ session: any; events?: any[]; messages?: any[] }> {
    return this.rpc("session/read", { sessionId, include });
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  async sessionEvents(sessionId: string, limit?: number): Promise<any[]> {
    const { events } = await this.rpc("session/events", { sessionId, limit });
    return events;
  }

  async sessionMessages(sessionId: string, limit?: number): Promise<any[]> {
    const { messages } = await this.rpc("session/messages", { sessionId, limit });
    return messages;
  }

  async sessionSearch(query: string): Promise<any[]> {
    const { results } = await this.rpc("session/search", { query });
    return results;
  }

  async sessionConversation(sessionId: string, limit?: number): Promise<any[]> {
    const { turns } = await this.rpc("session/conversation", { sessionId, limit });
    return turns;
  }

  async sessionSearchConversation(sessionId: string, query: string): Promise<any[]> {
    const { results } = await this.rpc("session/search-conversation", { sessionId, query });
    return results;
  }

  async worktreeFinish(sessionId: string, opts?: { noMerge?: boolean }): Promise<any> {
    return this.rpc("worktree/finish", { sessionId, ...opts });
  }

  // ── Messaging ───────────────────────────────────────────────────────────────

  async messageSend(sessionId: string, content: string): Promise<void> {
    await this.rpc("message/send", { sessionId, content });
  }

  async messageMarkRead(sessionId: string): Promise<void> {
    await this.rpc("message/markRead", { sessionId });
  }

  async gateApprove(sessionId: string): Promise<any> {
    return this.rpc("gate/approve", { sessionId });
  }

  // ── Resources ───────────────────────────────────────────────────────────────

  async agentList(): Promise<any[]> {
    const { agents } = await this.rpc("agent/list");
    return agents;
  }

  async flowList(): Promise<any[]> {
    const { flows } = await this.rpc("flow/list");
    return flows;
  }

  async flowRead(name: string): Promise<any> {
    const { flow } = await this.rpc("flow/read", { name });
    return flow;
  }

  async skillList(): Promise<any[]> {
    const { skills } = await this.rpc("skill/list");
    return skills;
  }

  async skillRead(name: string): Promise<any> {
    const { skill } = await this.rpc("skill/read", { name });
    return skill;
  }

  async recipeList(): Promise<any[]> {
    const { recipes } = await this.rpc("recipe/list");
    return recipes;
  }

  async recipeRead(name: string): Promise<any> {
    const { recipe } = await this.rpc("recipe/read", { name });
    return recipe;
  }

  async recipeUse(name: string, variables?: Record<string, string>): Promise<any> {
    const { session } = await this.rpc("recipe/use", { name, variables });
    return session;
  }

  async computeList(): Promise<any[]> {
    const { targets } = await this.rpc("compute/list");
    return targets;
  }

  async computeCreate(opts: Record<string, unknown>): Promise<any> {
    const { compute } = await this.rpc("compute/create", opts);
    return compute;
  }

  async computeDelete(name: string): Promise<void> {
    await this.rpc("compute/delete", { name });
  }

  async computeUpdate(name: string, fields: Record<string, unknown>): Promise<void> {
    await this.rpc("compute/update", { name, fields });
  }

  async computeRead(name: string): Promise<any> {
    const { compute } = await this.rpc("compute/read", { name });
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

  async computePing(name: string): Promise<{ reachable: boolean; message: string }> {
    return this.rpc("compute/ping", { name });
  }

  async computeCleanZombies(): Promise<{ cleaned: number }> {
    return this.rpc("compute/clean-zombies");
  }

  async groupList(): Promise<any[]> {
    const { groups } = await this.rpc("group/list");
    return groups;
  }

  async groupCreate(name: string): Promise<any> {
    const { group } = await this.rpc("group/create", { name });
    return group;
  }

  async groupDelete(name: string): Promise<void> {
    await this.rpc("group/delete", { name });
  }

  // ── Config ──────────────────────────────────────────────────────────────────

  async configRead(): Promise<any> {
    const { config } = await this.rpc("config/read");
    return config;
  }

  async configWrite(config: Record<string, unknown>): Promise<any> {
    const { config: updated } = await this.rpc("config/write", config);
    return updated;
  }

  async profileList(): Promise<{ profiles: any[]; active: string | null }> {
    return this.rpc("profile/list");
  }

  async profileSet(name: string): Promise<void> {
    await this.rpc("profile/set", { name });
  }

  // ── History ─────────────────────────────────────────────────────────────────

  async historyList(limit?: number): Promise<any[]> {
    const { items } = await this.rpc("history/list", { limit });
    return items;
  }

  async historyImport(claudeSessionId: string, opts?: { name?: string; repo?: string }): Promise<any> {
    const { session } = await this.rpc("history/import", { claudeSessionId, ...opts });
    return session;
  }

  async historyRefresh(): Promise<{ ok: boolean; count: number; sessionCount?: number }> {
    return this.rpc("history/refresh");
  }

  async historyIndex(): Promise<{ ok: boolean; count: number }> {
    return this.rpc("history/index");
  }

  async historyRebuildFts(): Promise<{ ok: boolean; sessionCount: number; indexCount: number; items: any[] }> {
    return this.rpc("history/rebuild-fts");
  }

  async historyRefreshAndIndex(): Promise<{ ok: boolean; sessionCount: number; indexCount: number; items: any[] }> {
    return this.rpc("history/refresh-and-index");
  }

  async historySearch(query: string, limit?: number): Promise<any[]> {
    const { results } = await this.rpc("history/search", { query, limit });
    return results;
  }

  // ── Tools ───────────────────────────────────────────────────────────────────

  async toolsList(projectRoot?: string): Promise<any[]> {
    const { tools } = await this.rpc("tools/list", { projectRoot });
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

  async metricsSnapshot(computeName?: string): Promise<any> {
    const { snapshot } = await this.rpc("metrics/snapshot", { computeName });
    return snapshot;
  }

  async costsRead(): Promise<{ costs: any[]; total: number }> {
    return this.rpc("costs/read");
  }

  // ── Session extended ────────────────────────────────────────────────────────

  async sessionOutput(sessionId: string, lines?: number): Promise<string> {
    const { output } = await this.rpc("session/output", { sessionId, lines });
    return output;
  }

  async sessionHandoff(sessionId: string, agent: string, instructions?: string): Promise<any> {
    return this.rpc("session/handoff", { sessionId, agent, instructions });
  }

  async sessionJoin(sessionId: string, force?: boolean): Promise<any> {
    return this.rpc("session/join", { sessionId, force });
  }

  async sessionSpawn(sessionId: string, opts: { task: string; agent?: string; model?: string; group_name?: string }): Promise<any> {
    return this.rpc("session/spawn", { sessionId, ...opts });
  }

  async sessionResume(sessionId: string): Promise<any> {
    return this.rpc("session/resume", { sessionId });
  }

  async sessionPause(sessionId: string, reason?: string): Promise<any> {
    return this.rpc("session/pause", { sessionId, reason });
  }

  // ── Memory ─────────────────────────────────────────────────────────────────

  async memoryList(scope?: string): Promise<any[]> {
    const { memories } = await this.rpc("memory/list", { scope });
    return memories;
  }

  async memoryRecall(query: string, opts?: { scope?: string; limit?: number }): Promise<any[]> {
    const { results } = await this.rpc("memory/recall", { query, ...opts });
    return results;
  }

  async memoryForget(id: string): Promise<boolean> {
    const { ok } = await this.rpc("memory/forget", { id });
    return ok;
  }

  // ── Profile extended ───────────────────────────────────────────────────────

  async profileCreate(name: string, description?: string): Promise<any> {
    const { profile } = await this.rpc("profile/create", { name, description });
    return profile;
  }

  async profileDelete(name: string): Promise<void> {
    await this.rpc("profile/delete", { name });
  }

  // ── Schedule ───────────────────────────────────────────────────────────────

  async scheduleList(): Promise<any[]> {
    const { schedules } = await this.rpc("schedule/list");
    return schedules;
  }

  async scheduleCreate(opts: Record<string, unknown>): Promise<any> {
    const { schedule } = await this.rpc("schedule/create", opts);
    return schedule;
  }

  async scheduleDelete(id: string): Promise<boolean> {
    const { ok } = await this.rpc("schedule/delete", { id });
    return ok;
  }

  async scheduleEnable(id: string): Promise<void> {
    await this.rpc("schedule/enable", { id });
  }

  async scheduleDisable(id: string): Promise<void> {
    await this.rpc("schedule/disable", { id });
  }

  // ── History extended ───────────────────────────────────────────────────────

  async indexStats(): Promise<any> {
    return this.rpc("history/index-stats");
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  close(): void {
    // Reject all pending requests
    for (const [id, p] of this.pending) {
      p.reject(new Error("Client closed"));
    }
    this.pending.clear();
    this.listeners.clear();
    this.transport.close();
  }
}
