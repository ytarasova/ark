/**
 * SystemClient -- config, profile, history, tools/mcp, schedule.
 *
 * These RPCs don't belong to a single domain; they sit at the
 * configuration + utility edge of the protocol surface. Lifecycle
 * (`initialize` / `close`) stays on the `ArkClient` facade because those
 * touch the transport directly.
 */

import type {
  Profile,
  ClaudeSession,
  ToolEntry,
  Schedule,
  SearchResult,
  HistoryListResult,
  HistoryRefreshResult,
  HistoryIndexResult,
  HistorySearchResult,
  HistoryRebuildFtsResult,
  HistoryImportResult,
  ScheduleListResult,
  ScheduleCreateResult,
  ScheduleDeleteResult,
  ProfileListResult,
  ProfileCreateResult,
  ToolsListResult,
  ConfigReadResult,
  IndexStatsResult,
  Session,
} from "../../types/index.js";
import type { RpcFn } from "./rpc.js";

export class SystemClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
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

  async profileCreate(name: string, description?: string): Promise<Profile> {
    const { profile } = await this.rpc<ProfileCreateResult>("profile/create", { name, description });
    return profile;
  }

  async profileDelete(name: string): Promise<void> {
    await this.rpc("profile/delete", { name });
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

  async indexStats(): Promise<IndexStatsResult> {
    return this.rpc<IndexStatsResult>("history/index-stats");
  }

  // ── Tools + MCP ─────────────────────────────────────────────────────────────

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

  // ── Schedule ────────────────────────────────────────────────────────────────

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
}
