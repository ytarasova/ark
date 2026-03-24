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
  cloneSession, handoff, fork, joinFork, getOutput, send,
  deleteSessionAsync,
} from "./session.js";

// Flow
export * from "./flow.js";

// Agent
export { loadAgent, listAgents, saveAgent, deleteAgent, resolveAgent, buildClaudeArgs } from "./agent.js";

// Claude integration
export * as claude from "./claude.js";

// Tmux
export * from "./tmux.js";

// Event bus
export * from "./hooks.js";

// Search
export { searchSessions, searchTranscripts, type SearchResult, type SearchOpts } from "./search.js";

// Conductor
export { startConductor } from "./conductor.js";
