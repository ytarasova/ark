import type { Session, CreateSessionOpts, SessionListFilters } from "./session.js";
import type { Compute, CreateComputeOpts } from "./compute.js";
import type { Event } from "./event.js";
import type { Message } from "./message.js";
import type { AgentDefinition, SkillDefinition, RuntimeDefinition } from "./agent.js";
import type { FlowDefinition, RecipeDefinition } from "./flow.js";
import type {
  ComputeSnapshot,
  Profile,
  ClaudeSession,
  ToolEntry,
  MemoryEntry,
  Schedule,
  SessionCost,
  ConversationTurn,
  SearchResult,
} from "./common.js";

// ── Session ─────────────────────────────────────────────────────────────────

export interface SessionStartParams extends CreateSessionOpts {}
export interface SessionStartResult {
  session: Session;
}

export interface SessionIdParams {
  sessionId: string;
}

export interface SessionListParams extends SessionListFilters {}
export interface SessionListResult {
  sessions: Session[];
}

export interface SessionReadParams {
  sessionId: string;
  include?: string[];
}
export interface SessionReadResult {
  session: Session;
  events?: Event[];
  messages?: Message[];
}

export interface SessionUpdateParams {
  sessionId: string;
  fields: Partial<Session>;
}
export interface SessionUpdateResult {
  session: Session;
}

export interface SessionAdvanceParams {
  sessionId: string;
  force?: boolean;
}
export interface SessionPauseParams {
  sessionId: string;
  reason?: string;
}

export interface SessionForkParams {
  sessionId: string;
  name?: string;
  group_name?: string;
}
export interface SessionForkResult {
  session: Session;
}

export interface SessionCloneParams {
  sessionId: string;
  name?: string;
}
export interface SessionCloneResult {
  session: Session;
}

export interface SessionOutputParams {
  sessionId: string;
  lines?: number;
}
export interface SessionOutputResult {
  output: string;
}

export interface SessionHandoffParams {
  sessionId: string;
  agent: string;
  instructions?: string;
}
export interface SessionJoinParams {
  sessionId: string;
  force?: boolean;
}
export interface SessionSpawnParams {
  sessionId: string;
  task: string;
  agent?: string;
  group_name?: string;
}

export interface SessionEventsParams {
  sessionId: string;
  limit?: number;
}
export interface SessionEventsResult {
  events: Event[];
}

export interface SessionMessagesParams {
  sessionId: string;
  limit?: number;
}
export interface SessionMessagesResult {
  messages: Message[];
}

export interface SessionSearchParams {
  query: string;
}
export interface SessionSearchResult {
  results: SearchResult[];
}

export interface SessionConversationParams {
  sessionId: string;
  limit?: number;
}
export interface SessionConversationResult {
  turns: ConversationTurn[];
}

export interface SessionSearchConversationParams {
  sessionId: string;
  query: string;
}
export interface SessionSearchConversationResult {
  results: SearchResult[];
}

export interface SessionResumeParams {
  sessionId: string;
  /** Optional snapshot id to restore from. When omitted, the session's latest snapshot is used. */
  snapshotId?: string;
  /**
   * Optional stage to rewind the flow to before re-dispatching. When set, the
   * session's `stage` is reset to this value, `claude_session_id` + `pr_url` are
   * cleared, and any cached flow-graph state downstream of the target stage is
   * dropped. Used by the "Restart from stage..." dialog in the web UI so users
   * can re-run a completed flow from any point (e.g. re-run `implement` after a
   * completed `pr` stage without starting the planner over).
   */
  rewindToStage?: string;
}

// ── Messaging ───────────────────────────────────────────────────────────────

export interface MessageSendParams {
  sessionId: string;
  content: string;
}

// ── Compute ─────────────────────────────────────────────────────────────────

export interface ComputeCreateParams extends CreateComputeOpts {}
export interface ComputeCreateResult {
  compute: Compute;
}

export interface ComputeNameParams {
  name: string;
}
export interface ComputeReadResult {
  compute: Compute;
}
export interface ComputeListResult {
  targets: Compute[];
}
export interface ComputeUpdateParams {
  name: string;
  fields: Partial<Compute>;
}
export interface ComputePingResult {
  reachable: boolean;
  message: string;
}
export interface ComputeCleanZombiesResult {
  cleaned: number;
}

/**
 * Shape of an isolation-mode descriptor as exposed over the wire. Mirrors
 * `IsolationMode` in `packages/compute/types.ts`; duplicated here to avoid a
 * cross-package import cycle into the compute layer.
 */
export interface ComputeIsolationMode {
  value: string;
  label: string;
}

/**
 * Authoritative capability flags for a compute target, read from the
 * provider instance. Returned by `compute/capabilities`. The UI uses this
 * to decide which action buttons to render (reboot, destroy, ...) instead
 * of hardcoding provider-name checks.
 */
export interface ComputeCapabilities {
  provider: string;
  singleton: boolean;
  canReboot: boolean;
  canDelete: boolean;
  needsAuth: boolean;
  supportsWorktree: boolean;
  initialStatus: string;
  isolationModes: ComputeIsolationMode[];
}

export interface ComputeCapabilitiesResult {
  capabilities: ComputeCapabilities;
}

// ── Resources ───────────────────────────────────────────────────────────────

export interface AgentListResult {
  agents: AgentDefinition[];
}
export interface AgentReadParams {
  name: string;
}
export interface AgentReadResult {
  agent: AgentDefinition;
}

export interface RuntimeListResult {
  runtimes: RuntimeDefinition[];
}
export interface RuntimeReadParams {
  name: string;
}
export interface RuntimeReadResult {
  runtime: RuntimeDefinition;
}

export interface FlowListResult {
  flows: FlowDefinition[];
}
export interface FlowReadParams {
  name: string;
}
export interface FlowReadResult {
  flow: FlowDefinition;
}

/**
 * `flow/validate` -- dry-run validation for a flow payload (#403). Runs the
 * same Zod + DAG + requires_repo + declared-inputs checks that `session/start`
 * would apply, without creating a session or registering the flow on the
 * ephemeral overlay. See `server/handlers/resource.ts`.
 */
export interface FlowValidateParams {
  /** Named flow (resolved via FlowStore) OR a literal inline flow definition. */
  flow: string | { name?: string; stages: Array<{ name: string; [k: string]: unknown }>; [k: string]: unknown };
  /** Session inputs to validate against the flow's declared contract. */
  inputs?: Record<string, unknown>;
  /** Optional repo; when unset, `requires_repo: true` flows report a problem. */
  repo?: string;
}
export interface FlowValidateResult {
  ok: boolean;
  problems: string[];
  flow?: { name: string; stages: string[] };
}

export interface SkillListResult {
  skills: SkillDefinition[];
}
export interface SkillReadParams {
  name: string;
}
export interface SkillReadResult {
  skill: SkillDefinition;
}

export interface RecipeListResult {
  recipes: RecipeDefinition[];
}
export interface RecipeReadParams {
  name: string;
}
export interface RecipeReadResult {
  recipe: RecipeDefinition;
}
export interface RecipeUseParams {
  name: string;
  variables?: Record<string, string>;
}
export interface RecipeUseResult {
  session: Session;
}

// ── Groups ──────────────────────────────────────────────────────────────────

export interface GroupListResult {
  groups: Array<{ name: string; created_at: string }>;
}
export interface GroupCreateParams {
  name: string;
}
export interface GroupCreateResult {
  group: { name: string; created_at: string };
}
export interface GroupDeleteParams {
  name: string;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface ConfigReadResult {
  config: Record<string, unknown>;
}
export interface ConfigWriteParams extends Record<string, unknown> {}

export interface ProfileListResult {
  profiles: Profile[];
  active: string | null;
}
export interface ProfileCreateParams {
  name: string;
  description?: string;
}
export interface ProfileCreateResult {
  profile: Profile;
}
export interface ProfileSetParams {
  name: string;
}
export interface ProfileDeleteParams {
  name: string;
}

// ── History ─────────────────────────────────────────────────────────────────

export interface HistoryListParams {
  limit?: number;
}
export interface HistoryListResult {
  items: ClaudeSession[];
}
export interface HistoryImportParams {
  claudeSessionId: string;
  name?: string;
  repo?: string;
}
export interface HistoryImportResult {
  session: Session;
}
export interface HistoryRefreshResult {
  ok: boolean;
  count: number;
  sessionCount?: number;
}
export interface HistoryIndexResult {
  ok: boolean;
  count: number;
}
export interface HistorySearchParams {
  query: string;
  limit?: number;
}
export interface HistorySearchResult {
  results: SearchResult[];
}
export interface HistoryRebuildFtsResult {
  ok: boolean;
  sessionCount: number;
  indexCount: number;
  items: ClaudeSession[];
}
export interface IndexStatsResult {
  stats: Record<string, unknown>;
}

// ── Tools ───────────────────────────────────────────────────────────────────

export interface ToolsListParams {
  projectRoot?: string;
}
export interface ToolsListResult {
  tools: ToolEntry[];
}
export interface ToolsDeleteParams {
  name?: string;
  kind?: string;
  source?: string;
  scope?: string;
  id?: string;
  projectRoot?: string;
}
export interface ToolsReadParams {
  name: string;
  kind: string;
  projectRoot?: string;
}

export interface McpAttachParams {
  sessionId: string;
  server: Record<string, unknown>;
}
export interface McpDetachParams {
  sessionId: string;
  serverName: string;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export interface MetricsSnapshotParams {
  computeName?: string;
}
export interface MetricsSnapshotResult {
  snapshot: ComputeSnapshot | null;
}

export interface CostsReadResult {
  costs: SessionCost[];
  total: number;
}

// ── Memory ──────────────────────────────────────────────────────────────────

export interface MemoryListParams {
  scope?: string;
}
export interface MemoryListResult {
  memories: MemoryEntry[];
}
export interface MemoryRecallParams {
  query: string;
  scope?: string;
  limit?: number;
}
export interface MemoryRecallResult {
  results: MemoryEntry[];
}
export interface MemoryForgetParams {
  id: string;
}
export interface MemoryForgetResult {
  ok: boolean;
}
export interface MemoryAddParams {
  content: string;
  tags?: string[];
  scope?: string;
  importance?: number;
}
export interface MemoryAddResult {
  memory: MemoryEntry;
}
export interface MemoryClearParams {
  scope?: string;
}
export interface MemoryClearResult {
  count: number;
}

// ── Schedule ────────────────────────────────────────────────────────────────

export interface ScheduleListResult {
  schedules: Schedule[];
}
export interface ScheduleCreateParams extends Record<string, unknown> {}
export interface ScheduleCreateResult {
  schedule: Schedule;
}
export interface ScheduleDeleteParams {
  id: string;
}
export interface ScheduleDeleteResult {
  ok: boolean;
}
export interface ScheduleIdParams {
  id: string;
}

// ── Artifacts ──────────────────────────────────────────────────────────────

export interface ArtifactListParams {
  sessionId: string;
  type?: string;
}
export interface ArtifactListResult {
  artifacts: import("./artifact.js").SessionArtifact[];
}

export interface ArtifactQueryParams {
  session_id?: string;
  type?: string;
  value?: string;
  limit?: number;
}
export interface ArtifactQueryResult {
  artifacts: import("./artifact.js").SessionArtifact[];
}

// ── Worktree ────────────────────────────────────────────────────────────────

export interface WorktreeFinishParams {
  sessionId: string;
  noMerge?: boolean;
  createPR?: boolean;
}
