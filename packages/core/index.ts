/**
 * Ark Core - public API.
 */

// Database abstraction
export type { DatabaseAdapter, PreparedStatement } from "./database/index.js";
export { BunSqliteAdapter } from "./database/index.js";

// Re-exports
export { AppContext } from "./app.js";
export { safeParseConfig } from "./util.js";
export {
  loadConfig,
  type ArkConfig,
  type OtlpSettings,
  type RollbackSettings,
  type TelemetrySettings,
  type TensorZeroSettings,
} from "./config.js";

// Domain types (previously from store.ts, now from types/)
export type { Session, Event, Compute, Message } from "../types/index.js";

// Session orchestration types -- re-exported from the focused service modules.
export type { HookStatusResult, ReportResult } from "./services/session-hooks/index.js";
export type { SessionOpResult } from "./services/session/types.js";

// Flow
export * from "./state/flow.js";

// Template
export { substituteVars, buildSessionVars } from "./template.js";

// Agent
export {
  resolveAgent,
  resolveAgentWithRuntime,
  buildClaudeArgs,
  findProjectRoot,
  type AgentDefinition,
} from "./agent/agent.js";

// Skill
export { type SkillDefinition } from "./agent/skill.js";

// Recipe
export {
  instantiateRecipe,
  validateRecipeParams,
  resolveSubRecipe,
  listSubRecipes,
  sessionToRecipe,
  type RecipeDefinition,
  type RecipeVariable,
  type RecipeParameter,
  type RecipeInstance,
  type SubRecipeRef,
} from "./agent/recipe.js";

// Executor
export type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "./executor.js";
export { registerExecutor, getExecutor, listExecutors, resetExecutors } from "./executor.js";
export {
  claudeCodeExecutor,
  subprocessExecutor,
  cliAgentExecutor,
  gooseExecutor,
  builtinExecutors,
  loadPluginExecutors,
} from "./executors/index.js";
export { buildGooseCommand } from "./executors/goose.js";

// Plugin registry -- canonical source for extensible collections
export type { PluginRegistry, PluginEntry, PluginKind, PluginKindMap, PluginSource } from "./plugins/registry.js";
export { createPluginRegistry } from "./plugins/registry.js";
export { startStatusPoller, stopStatusPoller, stopAllPollers } from "./executors/status-poller.js";

// Session launcher abstraction
export type { SessionLauncher } from "./session-launcher.js";
export type { LaunchResult as SessionLaunchResult } from "./session-launcher.js";
export { TmuxLauncher, ContainerLauncher, ArkdLauncher } from "./launchers/index.js";

// Claude integration
export * as claude from "./claude/claude.js";

// Tmux
export * from "./infra/tmux.js";

// Event bus
export * from "./hooks.js";

// Search
export {
  searchSessions,
  searchTranscripts,
  indexTranscripts,
  indexSession,
  getIndexStats,
  getSessionConversation,
  searchSessionConversation,
  ftsTableExists,
  type SearchResult,
  type SearchOpts,
} from "./search/search.js";

// GitHub PR utilities (lookup, formatting)
export { findSessionByPR, formatReviewPrompt, extractComments } from "./integrations/github-pr.js";

// PR polling
export { pollPRReviews } from "./integrations/pr-poller.js";

// Issue polling
export {
  pollIssues,
  startIssuePoller,
  fetchLabeledIssues,
  createSessionFromIssue,
  type IssuePollerOptions,
  type GhIssue,
} from "./integrations/issue-poller.js";

// Conductor
export { startConductor } from "./conductor/conductor.js";

// Claude sessions
export {
  listClaudeSessions,
  getClaudeSession,
  refreshClaudeSessionsCache,
  type ClaudeSession,
} from "./claude/sessions.js";

// Repo-scoped config
export { loadRepoConfig, type RepoConfig } from "./repo-config.js";

// Schedules
export {
  createSchedule,
  listSchedules,
  getSchedule,
  deleteSchedule,
  enableSchedule,
  updateScheduleLastRun,
  cronMatches,
  type Schedule,
} from "./schedule.js";

// Skill extraction
export {
  extractSkillCandidates,
  extractAndSaveSkills,
  type SkillCandidate,
  type ConversationTurn,
} from "./agent/skill-extractor.js";

// Structured review output
export { parseReviewOutput, type ReviewResult, type ReviewIssue } from "./review.js";

// Guardrails
export { evaluateGuardrail, evaluateToolCall, DEFAULT_RULES, type GuardrailRule } from "./session/guardrails.js";

// Checkpoint and crash recovery
export {
  saveCheckpoint,
  getCheckpoint,
  listCheckpoints,
  findOrphanedSessions,
  recoverSession,
  type Checkpoint,
} from "./session/checkpoint.js";

// Safe async helper
export { safeAsync } from "./safe.js";

// Prerequisite checker
export { checkPrereqs, formatPrereqCheck, hasRequiredPrereqs, type PrereqResult } from "./prereqs.js";

// OS notifications
export { sendOSNotification } from "./notify.js";

// Unified tool discovery
export {
  discoverTools,
  removeMcpServer,
  removeCommand,
  getCommand,
  addMcpServer,
  addCommand,
  type ToolEntry,
} from "./tools.js";

// Replay
export { buildReplay, type ReplayStep } from "./session/replay.js";

// Tool drivers
export type { ToolDriver } from "./tool-driver.js";
export { getToolDriver, listToolDrivers, registerToolDriver } from "./tools/registry.js";

// Cost helpers -- read from usage_records (written by UsageRecorder)
export {
  calculateCost,
  formatCost,
  getSessionCost,
  getAllSessionCosts,
  checkBudget,
  syncCosts,
  exportCostsCsv,
  type SessionCostSummary,
  type BudgetConfig,
  type BudgetStatus,
} from "./observability/costs.js";

// Universal cost tracking (multi-runtime, multi-dimensional)
export { PricingRegistry, type ModelPricing, type TokenUsage } from "./observability/pricing.js";
export {
  UsageRecorder,
  type UsageRecord,
  type RecordOpts,
  type UsageSummaryRow,
  type DailyTrendRow,
  type CostMode,
} from "./observability/usage.js";

// Runtime transcript parsers (polymorphic)
export {
  TranscriptParserRegistry,
  type TranscriptParser,
  type ParseResult,
  type FindOpts,
} from "./runtimes/transcript-parser.js";
export { ClaudeTranscriptParser } from "./runtimes/claude/parser.js";
export { CodexTranscriptParser } from "./runtimes/codex/parser.js";
export { GeminiTranscriptParser } from "./runtimes/gemini/parser.js";

// Conductor learnings (migrated to KnowledgeStore -- kept as type re-exports for backward compat)
// recordLearning, getLearnings, getPolicies removed -- use app.knowledge directly

// Reliable send
export { sendReliable, hasPasteMarker, isReadyForInput, type SendOptions } from "./send-reliable.js";

// Messaging bridge
export {
  Bridge,
  loadBridgeConfig,
  createBridge,
  type BridgeConfig,
  type BridgeMessage,
} from "./integrations/bridge.js";

// Docker sandbox
export { buildSandboxCommand, isDockerAvailable, listSandboxContainers, type SandboxConfig } from "./sandbox.js";

// Hotkey remapping
export { getHotkeys, matchesHotkey, resetHotkeys, hotkeyLabel, type HotkeyMap } from "./hotkeys.js";

// Log management
export { truncateLog, cleanupLogs, logDir, type LogManagerOptions } from "./observability/log-manager.js";

// Session sharing
export { exportSession, exportSessionToFile, importSessionFromFile, type SessionExport } from "./session/share.js";

// Auto-update check
export { checkForUpdate, getCurrentVersion } from "./infra/update-check.js";

// Tmux status bar notifications
export { updateTmuxStatusBar, clearTmuxStatusBar } from "./infra/tmux-notify.js";

// Profiles
export {
  listProfiles,
  createProfile,
  deleteProfile,
  getActiveProfile,
  setActiveProfile,
  profileGroupPrefix,
  setProfilesArkDir,
  type Profile,
} from "./state/profiles.js";

// Notification daemon
export { NotifyDaemon, startNotifyDaemon, type NotifyDaemonOptions } from "./infra/notify-daemon.js";

// Global search
export { searchAllConversations, type GlobalSearchResult } from "./search/global-search.js";

// Tmux content-based status detection
export {
  detectStatusFromContent,
  detectSessionStatus,
  stripAnsi,
  parseAgentProgress,
  type DetectedStatus,
} from "./observability/status-detect.js";

// Multi-instance coordination
export { registerInstance, activeInstanceCount } from "./infra/instance-lock.js";

// Theme
export { getTheme, setThemeMode, getThemeMode, type Theme, type ThemeMode } from "./theme.js";

// UI state persistence
export { loadUiState, saveUiState, type UiState } from "./state/ui-state.js";

// MCP Socket Pool
export {
  McpPool,
  getMcpPool,
  destroyMcpPool,
  discoverPoolSockets,
  runMcpProxy,
  type McpServerDef,
  type PoolConfig,
} from "./mcp-pool.js";

// Prompt injection detection
export { detectInjection, hasInjection, type InjectionResult } from "./session/prompt-guard.js";

// Telemetry
export {
  track,
  getBuffer,
  clearBuffer,
  flush,
  enableTelemetry,
  disableTelemetry,
  isTelemetryEnabled,
  configureTelemetry,
  resetTelemetry,
  type TelemetryEvent,
  type TelemetryConfig,
} from "./observability/telemetry.js";

// OpenAPI spec
export { generateOpenApiSpec } from "./openapi.js";

// Web dashboard
export { startWebServer, type WebServerOptions } from "./hosted/web.js";
export { startWebProxy, type WebProxyOptions } from "./hosted/web-proxy.js";

// SSE bus (pluggable broadcast for scaling)
export { type SSEBus, InMemorySSEBus, createSSEBus } from "./hosted/sse-bus.js";
export { RedisSSEBus } from "./hosted/sse-redis.js";

// Worker registry and scheduler (hosted control plane)
export { WorkerRegistry, type WorkerNode } from "./hosted/worker-registry.js";
export { SessionScheduler } from "./hosted/scheduler.js";
export { startHostedServer } from "./hosted/server.js";

// Tenant compute policies
export { TenantPolicyManager, type TenantComputePolicy, type ComputePoolRef } from "./auth/index.js";

// Compute pools
export { ComputePoolManager, type ComputePool, type ComputePoolStatus, initPoolSchema } from "./compute/pool.js";

// Runtime evals (knowledge-backed agent performance tracking)
export { evaluateSession, getAgentStats, detectDrift, listEvals } from "./knowledge/evals.js";
export type { AgentEvalResult } from "./knowledge/evals.js";

// Observability hooks
export {
  configureObservability,
  getObservabilityConfig,
  recordEvent,
  flush as flushObservability,
  getEventBuffer,
  resetObservability,
  type ObservabilityConfig,
  type ObservabilityEvent,
} from "./observability.js";

// OTLP observability
export {
  configureOtlp,
  resetOtlp,
  flushSpans,
  startSpan,
  endSpan,
  getSpanBuffer,
  emitSessionSpanStart,
  emitSessionSpanEnd,
  emitStageSpanStart,
  emitStageSpanEnd,
  getSessionTraceId,
  type OtlpConfig,
  type OtlpSpan,
} from "./observability/otlp.js";

// Auto-rollback
export {
  watchMergedPR,
  shouldRollback,
  allCompleted,
  createRevertPayload,
  pollCheckSuites,
  type RollbackConfig,
  type CheckSuiteResult,
  type RevertPayload,
} from "./integrations/rollback.js";

// Structured JSONL logging
export {
  log,
  logDebug,
  logInfo,
  logWarn,
  logError,
  setLogLevel,
  setLogComponents,
  setLogArkDir,
  type LogComponent,
  type LogLevel,
} from "./observability/structured-log.js";

// Extension catalog
export {
  EXTENSION_CATALOG,
  searchCatalog,
  getCatalogByCategory,
  getCatalogEntry,
  type ExtensionEntry,
} from "./extension-catalog.js";

// Graph-based flow definitions
export {
  parseGraphFlow,
  getSuccessors,
  getPredecessors,
  isJoinNode,
  isFanOutNode,
  topologicalSort,
  validateGraphFlow,
  type GraphFlow,
  type FlowNode,
  type FlowEdge,
} from "./state/graph-flow.js";

// Composable termination conditions
export {
  evaluateTermination,
  parseTermination,
  maxTurns,
  maxTokens,
  timeout,
  textMention,
  and,
  or,
  type TerminationCondition,
  type TerminationContext,
} from "./termination.js";

// Flow state persistence -- moved to FlowStateRepository (see repositories/flow-state.ts).
// Callers: `app.flowStates.*` instead of the old free functions.
export { FlowStateRepository, type FlowState, type StageResult } from "./repositories/flow-state.js";

// Cross-session memory (migrated to KnowledgeStore -- old file-based memory removed)
// remember, recall, forget, listMemories, clearMemories, formatMemoriesForPrompt removed -- use app.knowledge directly

// Knowledge graph store
export { KnowledgeStore } from "./knowledge/index.js";
export type { KnowledgeNode, KnowledgeEdge, ContextPackage, NodeType, EdgeRelation } from "./knowledge/index.js";

// TensorZero LLM gateway
export { generateTensorZeroConfig, TensorZeroManager } from "./router/index.js";
export type { TensorZeroConfigOpts, TensorZeroManagerOpts } from "./router/index.js";

// GitHub issue webhook
export {
  handleIssueWebhook,
  type IssueWebhookPayload,
  type IssueWebhookConfig,
} from "./integrations/github-webhook.js";

// Agent-initiated handoff
export { detectHandoff, hasHandoff, type HandoffSignal } from "./handoff.js";

// Per-agent message filtering
export { filterMessages, parseMessageFilter, type MessageFilter, type FilteredMessage } from "./message-filter.js";

// Task/progress ledger -- moved to LedgerRepository (see repositories/ledger.ts).
// Callers: `app.ledger.*` instead of the old free functions.
export {
  LedgerRepository,
  type Ledger,
  type LedgerEntry,
  type LedgerEntryType,
  type LedgerEntryStatus,
} from "./repositories/ledger.js";

// Agent Client Protocol (headless JSON-RPC)
export { handleAcpRequest, runAcpServer, type AcpRequest, type AcpResponse } from "./acp.js";

// Repository map generation
export { generateRepoMap, extractExports, formatRepoMap, type RepoMap, type RepoMapEntry } from "./repo-map.js";

// Hybrid search (migrated to KnowledgeStore -- old hybrid-search removed)
// hybridSearch, mergeAndDeduplicate removed -- use app.knowledge.search() directly

// Types from packages/types -- stricter domain types (aliased to avoid collision with store types)
export type {
  Session as SessionDomain,
  SessionStatus,
  SessionConfig,
  CreateSessionOpts,
  SessionListFilters,
} from "../types/index.js";
export type {
  Compute as ComputeDomain,
  ComputeStatus,
  ComputeProviderName,
  ComputeConfig,
  CreateComputeOpts,
} from "../types/index.js";
export type { Event as EventDomain } from "../types/index.js";
export type { Message as MessageDomain, MessageRole, MessageType } from "../types/index.js";
export type { ComputeSnapshot, PortDecl } from "../types/index.js";
export type { AgentDefinition as AgentDefinitionDomain } from "../types/index.js";
// GateType is from types/flow.ts -- FlowDefinition/StageDefinition already come from ./flow.js via export *
export type { GateType } from "../types/index.js";

// Auth and multi-tenancy
export {
  extractTenantContext,
  canWrite,
  isAdmin,
  DEFAULT_AUTH_CONFIG,
  DEFAULT_TENANT_CONTEXT,
  type AuthConfig,
} from "./auth/index.js";
export { ApiKeyManager } from "./auth/index.js";
export type { TenantContext, ApiKey } from "../types/index.js";

// Repositories
export {
  SessionRepository,
  ComputeRepository,
  EventRepository,
  MessageRepository,
  TodoRepository,
} from "./repositories/index.js";

// Services
export { SessionService, ComputeService, HistoryService } from "./services/index.js";

// Resource stores
export { type FlowStore, type FlowSummary, FileFlowStore } from "./stores/index.js";
export { type SkillStore, FileSkillStore } from "./stores/index.js";
export { type AgentStore, FileAgentStore } from "./stores/index.js";
export { type RecipeStore, FileRecipeStore } from "./stores/index.js";
export { type RuntimeStore, FileRuntimeStore } from "./stores/index.js";
export { type ModelStore, FileModelStore } from "./stores/index.js";
