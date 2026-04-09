/**
 * Ark Core - public API.
 */

// Convenience re-exports (delegate to AppContext repos)
export { getApp, setApp, clearApp, AppContext } from "./app.js";
export { ARK_DIR, DB_PATH, TRACKS_DIR, WORKTREES_DIR } from "./paths.js";
export { safeParseConfig } from "./util.js";
export { loadConfig, type ArkConfig, type OtlpSettings, type RollbackSettings, type TelemetrySettings } from "./config.js";

// Domain types (previously from store.ts, now from types/)
export type { Session, Event, Compute, Message } from "../types/index.js";

// ── Convenience wrappers (delegate to AppContext repos/services) ────────────
import { getApp as _getApp } from "./app.js";
import type { CreateSessionOpts, SessionListFilters } from "../types/index.js";

// Session CRUD
export function createSession(opts: CreateSessionOpts) { return _getApp().sessions.create(opts); }
export function getSession(id: string) { return _getApp().sessions.get(id); }
export function listSessions(filters?: SessionListFilters) { return _getApp().sessions.list(filters); }
export function updateSession(id: string, fields: Partial<import("../types/index.js").Session>) { return _getApp().sessions.update(id, fields); }
export function softDeleteSession(id: string) { return _getApp().sessions.softDelete(id); }
export function undeleteSession(id: string) { return _getApp().sessions.undelete(id); }
export function deleteSession(id: string): boolean { return _getApp().sessions.delete(id); }

// Groups
export function createGroup(name: string) { return _getApp().sessions.createGroup(name); }
export function deleteGroup(name: string) { return _getApp().sessions.deleteGroup(name); }
export function getGroups() { return _getApp().sessions.getGroups().map(g => g.name); }

// Event CRUD
export function getEvents(sessionId: string, filters?: { type?: string }) { return _getApp().events.list(sessionId, filters); }
export function logEvent(sessionId: string, type: string, data?: Record<string, unknown>) { return _getApp().events.log(sessionId, type, data); }

// Compute CRUD
export function createCompute(opts: { name: string; provider: string; [k: string]: unknown }) { return _getApp().computes.create(opts as import("../types/index.js").CreateComputeOpts); }
export function getCompute(name: string) { return _getApp().computes.get(name); }
export function listCompute() { return _getApp().computes.list(); }
export function updateCompute(name: string, fields: Partial<import("../types/index.js").Compute>) { return _getApp().computes.update(name, fields); }
export function mergeComputeConfig(name: string, config: Record<string, unknown>) { return _getApp().computes.mergeConfig(name, config); }
export function deleteCompute(name: string) { return _getApp().computes.delete(name); }

// Session lifecycle (the main API)
// Thin wrappers inject _getApp() so callers don't need to pass AppContext.
import {
  startSession as _startSession,
  dispatch as _dispatch,
  advance as _advance,
  stop as _stop,
  resume as _resume,
  complete as _complete,
  pause as _pause,
  interrupt as _interrupt,
  archive as _archive,
  restore as _restore,
  forkSession as _forkSession,
  cloneSession as _cloneSession,
  handoff as _handoff,
  fork as _fork,
  joinFork as _joinFork,
  getOutput as _getOutput,
  send as _send,
  deleteSessionAsync as _deleteSessionAsync,
  undeleteSessionAsync as _undeleteSessionAsync,
  waitForCompletion as _waitForCompletion,
  approveReviewGate as _approveReviewGate,
  applyHookStatus as _applyHookStatus,
  applyReport as _applyReport,
  cleanupOnTerminal as _cleanupOnTerminal,
  retryWithContext as _retryWithContext,
  fanOut as _fanOut,
  worktreeDiff as _worktreeDiff,
  finishWorktree as _finishWorktree,
  createWorktreePR as _createWorktreePR,
  detectStatus as _detectStatus,
  executeAction as _executeAction,
  spawnSubagent as _spawnSubagent,
  spawnParallelSubagents as _spawnParallelSubagents,
  findOrphanedWorktrees as _findOrphanedWorktrees,
  cleanupWorktrees as _cleanupWorktrees,
  runVerification as _runVerification,
  type HookStatusResult, type ReportResult, type SessionOpResult,
} from "./services/session-orchestration.js";

export type { HookStatusResult, ReportResult, SessionOpResult };

export function startSession(...args: Parameters<typeof _startSession> extends [any, ...infer R] ? R : never) { return _startSession(_getApp(), ...args); }
export function dispatch(...args: Parameters<typeof _dispatch> extends [any, ...infer R] ? R : never) { return _dispatch(_getApp(), ...args); }
export function advance(...args: Parameters<typeof _advance> extends [any, ...infer R] ? R : never) { return _advance(_getApp(), ...args); }
export function stop(...args: Parameters<typeof _stop> extends [any, ...infer R] ? R : never) { return _stop(_getApp(), ...args); }
export function resume(...args: Parameters<typeof _resume> extends [any, ...infer R] ? R : never) { return _resume(_getApp(), ...args); }
export function complete(...args: Parameters<typeof _complete> extends [any, ...infer R] ? R : never) { return _complete(_getApp(), ...args); }
export function pause(...args: Parameters<typeof _pause> extends [any, ...infer R] ? R : never) { return _pause(_getApp(), ...args); }
export function interrupt(...args: Parameters<typeof _interrupt> extends [any, ...infer R] ? R : never) { return _interrupt(_getApp(), ...args); }
export function archive(...args: Parameters<typeof _archive> extends [any, ...infer R] ? R : never) { return _archive(_getApp(), ...args); }
export function restore(...args: Parameters<typeof _restore> extends [any, ...infer R] ? R : never) { return _restore(_getApp(), ...args); }
export function forkSession(...args: Parameters<typeof _forkSession> extends [any, ...infer R] ? R : never) { return _forkSession(_getApp(), ...args); }
export function cloneSession(...args: Parameters<typeof _cloneSession> extends [any, ...infer R] ? R : never) { return _cloneSession(_getApp(), ...args); }
export function handoff(...args: Parameters<typeof _handoff> extends [any, ...infer R] ? R : never) { return _handoff(_getApp(), ...args); }
export function fork(...args: Parameters<typeof _fork> extends [any, ...infer R] ? R : never) { return _fork(_getApp(), ...args); }
export function joinFork(...args: Parameters<typeof _joinFork> extends [any, ...infer R] ? R : never) { return _joinFork(_getApp(), ...args); }
export function getOutput(...args: Parameters<typeof _getOutput> extends [any, ...infer R] ? R : never) { return _getOutput(_getApp(), ...args); }
export function send(...args: Parameters<typeof _send> extends [any, ...infer R] ? R : never) { return _send(_getApp(), ...args); }
export function deleteSessionAsync(...args: Parameters<typeof _deleteSessionAsync> extends [any, ...infer R] ? R : never) { return _deleteSessionAsync(_getApp(), ...args); }
export function undeleteSessionAsync(...args: Parameters<typeof _undeleteSessionAsync> extends [any, ...infer R] ? R : never) { return _undeleteSessionAsync(_getApp(), ...args); }
export function waitForCompletion(...args: Parameters<typeof _waitForCompletion> extends [any, ...infer R] ? R : never) { return _waitForCompletion(_getApp(), ...args); }
export function approveReviewGate(...args: Parameters<typeof _approveReviewGate> extends [any, ...infer R] ? R : never) { return _approveReviewGate(_getApp(), ...args); }
export function applyHookStatus(...args: Parameters<typeof _applyHookStatus> extends [any, ...infer R] ? R : never) { return _applyHookStatus(_getApp(), ...args); }
export function applyReport(...args: Parameters<typeof _applyReport> extends [any, ...infer R] ? R : never) { return _applyReport(_getApp(), ...args); }
export function cleanupOnTerminal(...args: Parameters<typeof _cleanupOnTerminal> extends [any, ...infer R] ? R : never) { return _cleanupOnTerminal(_getApp(), ...args); }
export function retryWithContext(...args: Parameters<typeof _retryWithContext> extends [any, ...infer R] ? R : never) { return _retryWithContext(_getApp(), ...args); }
export function fanOut(...args: Parameters<typeof _fanOut> extends [any, ...infer R] ? R : never) { return _fanOut(_getApp(), ...args); }
export function worktreeDiff(...args: Parameters<typeof _worktreeDiff> extends [any, ...infer R] ? R : never) { return _worktreeDiff(_getApp(), ...args); }
export function finishWorktree(...args: Parameters<typeof _finishWorktree> extends [any, ...infer R] ? R : never) { return _finishWorktree(_getApp(), ...args); }
export function createWorktreePR(...args: Parameters<typeof _createWorktreePR> extends [any, ...infer R] ? R : never) { return _createWorktreePR(_getApp(), ...args); }
export function detectStatus(...args: Parameters<typeof _detectStatus> extends [any, ...infer R] ? R : never) { return _detectStatus(_getApp(), ...args); }
export function executeAction(...args: Parameters<typeof _executeAction> extends [any, ...infer R] ? R : never) { return _executeAction(_getApp(), ...args); }
export function spawnSubagent(...args: Parameters<typeof _spawnSubagent> extends [any, ...infer R] ? R : never) { return _spawnSubagent(_getApp(), ...args); }
export function spawnParallelSubagents(...args: Parameters<typeof _spawnParallelSubagents> extends [any, ...infer R] ? R : never) { return _spawnParallelSubagents(_getApp(), ...args); }
export function findOrphanedWorktrees(...args: Parameters<typeof _findOrphanedWorktrees> extends [any, ...infer R] ? R : never) { return _findOrphanedWorktrees(_getApp(), ...args); }
export function cleanupWorktrees(...args: Parameters<typeof _cleanupWorktrees> extends [any, ...infer R] ? R : never) { return _cleanupWorktrees(_getApp(), ...args); }
export function runVerification(...args: Parameters<typeof _runVerification> extends [any, ...infer R] ? R : never) { return _runVerification(_getApp(), ...args); }

// Flow
export * from "./flow.js";

// Template
export { substituteVars, buildSessionVars } from "./template.js";

// Agent
export { loadAgent, listAgents, saveAgent, deleteAgent, resolveAgent, buildClaudeArgs, findProjectRoot, type AgentDefinition } from "./agent.js";

// Skill
export { listSkills, loadSkill, saveSkill, deleteSkill, type SkillDefinition } from "./skill.js";

// Recipe
export { listRecipes, loadRecipe, instantiateRecipe, validateRecipeParams, resolveSubRecipe, listSubRecipes, saveRecipe, deleteRecipe, sessionToRecipe, type RecipeDefinition, type RecipeVariable, type RecipeParameter, type RecipeInstance, type SubRecipeRef } from "./recipe.js";

// Executor
export type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "./executor.js";
export { registerExecutor, getExecutor, listExecutors, resetExecutors } from "./executor.js";
export { claudeCodeExecutor } from "./executors/claude-code.js";
export { subprocessExecutor } from "./executors/subprocess.js";
export { cliAgentExecutor } from "./executors/cli-agent.js";
export { startStatusPoller, stopStatusPoller, stopAllPollers } from "./executors/status-poller.js";

// Claude integration
export * as claude from "./claude.js";

// Tmux
export * from "./tmux.js";

// Event bus
export * from "./hooks.js";

// Search
export { searchSessions, searchTranscripts, indexTranscripts, indexSession, getIndexStats, getSessionConversation, searchSessionConversation, ftsTableExists, type SearchResult, type SearchOpts } from "./search.js";

// GitHub PR utilities (lookup, formatting)
export { findSessionByPR, formatReviewPrompt, extractComments } from "./github-pr.js";

// PR polling
export { pollPRReviews } from "./pr-poller.js";

// Issue polling
export { pollIssues, startIssuePoller, fetchLabeledIssues, createSessionFromIssue, type IssuePollerOptions, type GhIssue } from "./issue-poller.js";

// Conductor
export { startConductor } from "./conductor.js";

// Claude sessions
export { listClaudeSessions, getClaudeSession, refreshClaudeSessionsCache, type ClaudeSession } from "./claude-sessions.js";

// Repo-scoped config
export { loadRepoConfig, type RepoConfig } from "./repo-config.js";

// Schedules
export { createSchedule, listSchedules, getSchedule, deleteSchedule, enableSchedule, updateScheduleLastRun, cronMatches, type Schedule } from "./schedule.js";

// Skill extraction
export { extractSkillCandidates, extractAndSaveSkills, type SkillCandidate, type ConversationTurn } from "./skill-extractor.js";

// Structured review output
export { parseReviewOutput, type ReviewResult, type ReviewIssue } from "./review.js";

// Guardrails
export { evaluateGuardrail, evaluateToolCall, DEFAULT_RULES, type GuardrailRule } from "./guardrails.js";

// Checkpoint and crash recovery
export { saveCheckpoint, getCheckpoint, listCheckpoints, findOrphanedSessions, recoverSession, type Checkpoint } from "./checkpoint.js";

// Safe async helper
export { safeAsync } from "./safe.js";

// Prerequisite checker
export { checkPrereqs, formatPrereqCheck, hasRequiredPrereqs, type PrereqResult } from "./prereqs.js";

// OS notifications
export { sendOSNotification } from "./notify.js";

// Unified tool discovery
export { discoverTools, removeMcpServer, removeCommand, getCommand, addMcpServer, addCommand, type ToolEntry } from "./tools.js";

// Replay
export { buildReplay, type ReplayStep } from "./replay.js";

// Tool drivers
export type { ToolDriver } from "./tool-driver.js";
export { getToolDriver, listToolDrivers, registerToolDriver } from "./tools/registry.js";

// Cost tracking
export { calculateCost, formatCost, getSessionCost, getAllSessionCosts, checkBudget, syncCosts, exportCostsCsv, type SessionCost, type BudgetConfig, type BudgetStatus } from "./costs.js";

// Conductor learnings
export { recordLearning, getLearnings, getPolicies, conductorLearningsDir, type Learning, type Policy } from "./learnings.js";

// Reliable send
export { sendReliable, hasPasteMarker, isReadyForInput, type SendOptions } from "./send-reliable.js";

// Messaging bridge
export { Bridge, loadBridgeConfig, createBridge, type BridgeConfig, type BridgeMessage } from "./bridge.js";

// Docker sandbox
export { buildSandboxCommand, isDockerAvailable, listSandboxContainers, type SandboxConfig } from "./sandbox.js";

// Hotkey remapping
export { getHotkeys, matchesHotkey, resetHotkeys, hotkeyLabel, type HotkeyMap } from "./hotkeys.js";

// Log management
export { truncateLog, cleanupLogs, logDir, type LogManagerOptions } from "./log-manager.js";

// Session sharing
export { exportSession, exportSessionToFile, importSessionFromFile, type SessionExport } from "./session-share.js";

// Auto-update check
export { checkForUpdate, getCurrentVersion } from "./update-check.js";

// Tmux status bar notifications
export { updateTmuxStatusBar, clearTmuxStatusBar } from "./tmux-notify.js";

// Profiles
export { listProfiles, createProfile, deleteProfile, getActiveProfile, setActiveProfile, profileGroupPrefix, type Profile } from "./profiles.js";

// Notification daemon
export { NotifyDaemon, startNotifyDaemon, type NotifyDaemonOptions } from "./notify-daemon.js";

// Global search
export { searchAllConversations, type GlobalSearchResult } from "./global-search.js";

// Tmux content-based status detection
export { detectStatusFromContent, detectSessionStatus, stripAnsi, parseAgentProgress, type DetectedStatus } from "./status-detect.js";

// Multi-instance coordination
export { registerInstance, activeInstanceCount } from "./instance-lock.js";

// Theme
export { getTheme, setThemeMode, getThemeMode, type Theme, type ThemeMode } from "./theme.js";

// UI state persistence
export { loadUiState, saveUiState, type UiState } from "./ui-state.js";

// MCP Socket Pool
export { McpPool, getMcpPool, destroyMcpPool, discoverPoolSockets, runMcpProxy, type McpServerDef, type PoolConfig } from "./mcp-pool.js";

// Prompt injection detection
export { detectInjection, hasInjection, type InjectionResult } from "./prompt-guard.js";

// Telemetry
export { track, getBuffer, clearBuffer, flush, enableTelemetry, disableTelemetry, isTelemetryEnabled, configureTelemetry, resetTelemetry, type TelemetryEvent, type TelemetryConfig } from "./telemetry.js";

// OpenAPI spec
export { generateOpenApiSpec } from "./openapi.js";

// Web dashboard
export { startWebServer, type WebServerOptions } from "./web.js";

// Evals framework
export { loadEvalSuite, scoreOutput, saveEvalResults, listEvalSuites, summarizeResults, type EvalScenario, type EvalResult, type EvalSuite } from "./evals.js";

// Observability hooks
export { configureObservability, getObservabilityConfig, recordEvent, flush as flushObservability, getEventBuffer, resetObservability, type ObservabilityConfig, type ObservabilityEvent } from "./observability.js";

// OTLP observability
export { configureOtlp, resetOtlp, flushSpans, startSpan, endSpan, getSpanBuffer, emitSessionSpanStart, emitSessionSpanEnd, emitStageSpanStart, emitStageSpanEnd, getSessionTraceId, type OtlpConfig, type OtlpSpan } from "./otlp.js";

// Auto-rollback
export { watchMergedPR, shouldRollback, allCompleted, createRevertPayload, pollCheckSuites, type RollbackConfig, type CheckSuiteResult, type RevertPayload } from "./rollback.js";

// Structured JSONL logging
export { log, logDebug, logInfo, logWarn, logError, setLogLevel, setLogComponents, type LogComponent, type LogLevel } from "./structured-log.js";

// Extension catalog
export { EXTENSION_CATALOG, searchCatalog, getCatalogByCategory, getCatalogEntry, type ExtensionEntry } from "./extension-catalog.js";

// Graph-based flow definitions
export { parseGraphFlow, getSuccessors, getPredecessors, isJoinNode, isFanOutNode, topologicalSort, validateGraphFlow, type GraphFlow, type FlowNode, type FlowEdge } from "./graph-flow.js";

// Composable termination conditions
export { evaluateTermination, parseTermination, maxTurns, maxTokens, timeout, textMention, and, or, type TerminationCondition, type TerminationContext } from "./termination.js";

// Flow state persistence
export { saveFlowState, loadFlowState, markStageCompleted, setCurrentStage, isStageCompleted, deleteFlowState, type FlowState } from "./flow-state.js";

// Cross-session memory
export { remember, recall, forget, listMemories, clearMemories, formatMemoriesForPrompt, type MemoryEntry } from "./memory.js";

// Knowledge ingestion
export { ingestFile, ingestDirectory, queryKnowledge, chunkText } from "./knowledge.js";

// GitHub issue webhook
export { handleIssueWebhook, type IssueWebhookPayload, type IssueWebhookConfig } from "./github-webhook.js";

// Agent-initiated handoff
export { detectHandoff, hasHandoff, type HandoffSignal } from "./handoff.js";

// Per-agent message filtering
export { filterMessages, parseMessageFilter, type MessageFilter, type FilteredMessage } from "./message-filter.js";

// Task/progress ledger
export { loadLedger, saveLedger, addEntry, updateEntry, detectStall, formatLedgerForPrompt, type Ledger, type LedgerEntry } from "./ledger.js";

// Recipe evaluation
export { evaluateRecipeSetup, type RecipeEvalResult } from "./recipe-eval.js";

// Agent Client Protocol (headless JSON-RPC)
export { handleAcpRequest, runAcpServer, type AcpRequest, type AcpResponse } from "./acp.js";

// Repository map generation
export { generateRepoMap, extractExports, formatRepoMap, type RepoMap, type RepoMapEntry } from "./repo-map.js";

// Hybrid search
export { hybridSearch, mergeAndDeduplicate, type HybridSearchResult, type HybridSearchOpts } from "./hybrid-search.js";

// Types from packages/types — stricter domain types (aliased to avoid collision with store types)
export type { Session as SessionDomain, SessionStatus, SessionConfig, CreateSessionOpts, SessionListFilters } from "../types/index.js";
export type { Compute as ComputeDomain, ComputeStatus, ComputeProviderName, ComputeConfig, CreateComputeOpts } from "../types/index.js";
export type { Event as EventDomain } from "../types/index.js";
export type { Message as MessageDomain, MessageRole, MessageType } from "../types/index.js";
export type { ComputeSnapshot, PortDecl } from "../types/index.js";
export type { AgentDefinition as AgentDefinitionDomain } from "../types/index.js";
// GateType is from types/flow.ts — FlowDefinition/StageDefinition already come from ./flow.js via export *
export type { GateType } from "../types/index.js";

// Repositories
export { SessionRepository, ComputeRepository, EventRepository, MessageRepository, TodoRepository } from "./repositories/index.js";

// Services
export { SessionService, ComputeService, HistoryService } from "./services/index.js";

// Resource stores
export { type FlowStore, type FlowSummary, FileFlowStore } from "./stores/index.js";
export { type SkillStore, FileSkillStore } from "./stores/index.js";
export { type AgentStore, FileAgentStore } from "./stores/index.js";
export { type RecipeStore, FileRecipeStore } from "./stores/index.js";
