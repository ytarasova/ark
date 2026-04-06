import type { Session, CreateSessionOpts, SessionListFilters, SessionStatus, SessionConfig } from "./session.js";
import type { Compute, CreateComputeOpts, ComputeProviderName } from "./compute.js";
import type { Event } from "./event.js";
import type { Message } from "./message.js";
import type { AgentDefinition } from "./agent.js";
import type { FlowDefinition } from "./flow.js";
import type { SessionOpResult, ComputeSnapshot, SpawnOpts, WorktreeFinishOpts } from "./common.js";

// ── Session ─────────────────────────────────────────────────────────────────

export interface SessionStartParams extends CreateSessionOpts {}
export interface SessionStartResult { session: Session }

export interface SessionIdParams { sessionId: string }

export interface SessionListParams extends SessionListFilters {}
export interface SessionListResult { sessions: Session[] }

export interface SessionReadParams { sessionId: string; include?: string[] }
export interface SessionReadResult { session: Session; events?: Event[]; messages?: Message[] }

export interface SessionUpdateParams { sessionId: string; fields: Partial<Session> }
export interface SessionUpdateResult { session: Session }

export interface SessionDispatchParams { sessionId: string }
export interface SessionAdvanceParams { sessionId: string; force?: boolean }
export interface SessionPauseParams { sessionId: string; reason?: string }

export interface SessionForkParams { sessionId: string; name?: string; group_name?: string }
export interface SessionForkResult { session: Session }

export interface SessionCloneParams { sessionId: string; name?: string }
export interface SessionCloneResult { session: Session }

export interface SessionOutputParams { sessionId: string; lines?: number }
export interface SessionOutputResult { output: string }

export interface SessionHandoffParams { sessionId: string; agent: string; instructions?: string }
export interface SessionJoinParams { sessionId: string; force?: boolean }
export interface SessionSpawnParams { sessionId: string; task: string; agent?: string; model?: string; group_name?: string }

export interface SessionEventsParams { sessionId: string; limit?: number }
export interface SessionEventsResult { events: Event[] }

export interface SessionMessagesParams { sessionId: string; limit?: number }
export interface SessionMessagesResult { messages: Message[] }

export interface SessionSearchParams { query: string }
export interface SessionSearchResult { results: Session[] }

export interface SessionResumeParams { sessionId: string }

// ── Messaging ───────────────────────────────────────────────────────────────

export interface MessageSendParams { sessionId: string; content: string }

// ── Compute ─────────────────────────────────────────────────────────────────

export interface ComputeCreateParams extends CreateComputeOpts {}
export interface ComputeCreateResult { compute: Compute }

export interface ComputeNameParams { name: string }
export interface ComputeReadResult { compute: Compute }
export interface ComputeListResult { targets: Compute[] }
export interface ComputeUpdateParams { name: string; fields: Partial<Compute> }
export interface ComputePingResult { reachable: boolean; message: string }
export interface ComputeCleanZombiesResult { cleaned: number }

// ── Resources ───────────────────────────────────────────────────────────────

export interface AgentListResult { agents: AgentDefinition[] }
export interface AgentReadParams { name: string }
export interface AgentReadResult { agent: AgentDefinition }

export interface FlowListResult { flows: FlowDefinition[] }
export interface FlowReadParams { name: string }
export interface FlowReadResult { flow: FlowDefinition }

export interface SkillListResult { skills: any[] }
export interface SkillReadParams { name: string }
export interface SkillReadResult { skill: any }

export interface RecipeListResult { recipes: any[] }
export interface RecipeReadParams { name: string }
export interface RecipeReadResult { recipe: any }
export interface RecipeUseParams { name: string; variables?: Record<string, string> }
export interface RecipeUseResult { session: Session }

// ── Groups ──────────────────────────────────────────────────────────────────

export interface GroupListResult { groups: Array<{ name: string; created_at: string }> }
export interface GroupCreateParams { name: string }
export interface GroupCreateResult { group: { name: string; created_at: string } }
export interface GroupDeleteParams { name: string }

// ── Config ──────────────────────────────────────────────────────────────────

export interface ConfigReadResult { config: Record<string, unknown> }
export interface ConfigWriteParams extends Record<string, unknown> {}

export interface ProfileListResult { profiles: any[]; active: string | null }
export interface ProfileCreateParams { name: string; description?: string }
export interface ProfileCreateResult { profile: any }
export interface ProfileSetParams { name: string }
export interface ProfileDeleteParams { name: string }

// ── History ─────────────────────────────────────────────────────────────────

export interface HistoryListParams { limit?: number }
export interface HistoryListResult { items: any[] }
export interface HistoryImportParams { claudeSessionId: string; name?: string; repo?: string }
export interface HistoryImportResult { session: Session }
export interface HistoryRefreshResult { ok: boolean; count: number; sessionCount?: number }
export interface HistoryIndexResult { ok: boolean; count: number }
export interface HistorySearchParams { query: string; limit?: number }
export interface HistorySearchResult { results: any[] }
export interface HistoryRebuildFtsResult { ok: boolean; sessionCount: number; indexCount: number; items: any[] }
export interface IndexStatsResult { stats: Record<string, unknown> }

// ── Tools ───────────────────────────────────────────────────────────────────

export interface ToolsListParams { projectRoot?: string }
export interface ToolsListResult { tools: any[] }
export interface ToolsDeleteParams { name?: string; kind?: string; source?: string; scope?: string; id?: string; projectRoot?: string }
export interface ToolsReadParams { name: string; kind: string; projectRoot?: string }

export interface McpAttachParams { sessionId: string; server: Record<string, unknown> }
export interface McpDetachParams { sessionId: string; serverName: string }

// ── Metrics ─────────────────────────────────────────────────────────────────

export interface MetricsSnapshotParams { computeName?: string }
export interface MetricsSnapshotResult { snapshot: ComputeSnapshot }

export interface CostsReadResult { costs: any[]; total: number }

// ── Memory ──────────────────────────────────────────────────────────────────

export interface MemoryListParams { scope?: string }
export interface MemoryListResult { memories: any[] }
export interface MemoryRecallParams { query: string; scope?: string; limit?: number }
export interface MemoryRecallResult { results: any[] }
export interface MemoryForgetParams { id: string }
export interface MemoryForgetResult { ok: boolean }
export interface MemoryAddParams { content: string; tags?: string[]; scope?: string; importance?: number }
export interface MemoryAddResult { memory: any }
export interface MemoryClearParams { scope?: string }
export interface MemoryClearResult { count: number }

// ── Schedule ────────────────────────────────────────────────────────────────

export interface ScheduleListResult { schedules: any[] }
export interface ScheduleCreateParams extends Record<string, unknown> {}
export interface ScheduleCreateResult { schedule: any }
export interface ScheduleDeleteParams { id: string }
export interface ScheduleDeleteResult { ok: boolean }
export interface ScheduleIdParams { id: string }

// ── Worktree ────────────────────────────────────────────────────────────────

export interface WorktreeFinishParams { sessionId: string; noMerge?: boolean }
