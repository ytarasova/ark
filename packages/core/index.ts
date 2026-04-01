/**
 * Ark Core - public API.
 */

// Store (excluding createSession which is wrapped by session.ts)
export {
  ARK_DIR, DB_PATH, TRACKS_DIR, WORKTREES_DIR,
  getDb, getSession, listSessions, updateSession, deleteSession,
  logEvent, getEvents, getChildren, getGroups, createGroup, deleteGroup, claimSession,
  createCompute, getCompute, listCompute, updateCompute, mergeComputeConfig, deleteCompute,
  sessionChannelPort,
  addMessage, getMessages, getUnreadCount, markMessagesRead,
  type Message,
  createTestContext, setContext, resetContext, closeDb,
  rowToSession, type SessionRow,
  type Session, type Event, type Compute, type TestContext,
} from "./store.js";

// Context (DI)
export { getContext, type StoreContext } from "./context.js";

// App context
export { AppContext, getApp, setApp, clearApp } from "./app.js";
export { loadConfig, type ArkConfig } from "./config.js";

// Session lifecycle (the main API)
export {
  startSession, dispatch, advance, stop, resume, complete, pause,
  forkSession, cloneSession, handoff, fork, joinFork, getOutput, send,
  deleteSessionAsync, waitForCompletion, approveReviewGate,
  applyHookStatus, applyReport,
  retryWithContext, fanOut,
  type HookStatusResult, type ReportResult, type SessionOpResult,
} from "./session.js";

// Flow
export * from "./flow.js";

// Template
export { substituteVars, buildSessionVars } from "./template.js";

// Agent
export { loadAgent, listAgents, saveAgent, deleteAgent, resolveAgent, buildClaudeArgs, findProjectRoot, type AgentDefinition } from "./agent.js";

// Skill
export { listSkills, loadSkill, saveSkill, deleteSkill, type SkillDefinition } from "./skill.js";

// Recipe
export { listRecipes, loadRecipe, instantiateRecipe, type RecipeDefinition, type RecipeVariable, type RecipeInstance } from "./recipe.js";

// Claude integration
export * as claude from "./claude.js";

// Tmux
export * from "./tmux.js";

// Event bus
export * from "./hooks.js";

// Search
export { searchSessions, searchTranscripts, indexTranscripts, indexSession, getIndexStats, getSessionConversation, searchSessionConversation, type SearchResult, type SearchOpts } from "./search.js";

// GitHub PR utilities (lookup, formatting)
export { findSessionByPR, formatReviewPrompt, extractComments } from "./github-pr.js";

// PR polling
export { pollPRReviews } from "./pr-poller.js";

// Conductor
export { startConductor } from "./conductor.js";

// Claude sessions
export { listClaudeSessions, getClaudeSession, refreshClaudeSessionsCache, type ClaudeSession } from "./claude-sessions.js";

// Repo-scoped config
export { loadRepoConfig, type RepoConfig } from "./repo-config.js";

// Schedules
export { createSchedule, listSchedules, getSchedule, deleteSchedule, enableSchedule, updateScheduleLastRun, cronMatches, type Schedule } from "./schedule.js";

// Skill extraction
export { extractSkillCandidates, type SkillCandidate, type ConversationTurn } from "./skill-extractor.js";

// Structured review output
export { parseReviewOutput, type ReviewResult, type ReviewIssue } from "./review.js";

// Guardrails
export { evaluateGuardrail, DEFAULT_RULES, type GuardrailRule } from "./guardrails.js";
