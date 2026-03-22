/**
 * Ark Core - public API.
 */

// Store (excluding createSession which is wrapped by session.ts)
export {
  ARK_DIR, DB_PATH, TRACKS_DIR, WORKTREES_DIR,
  getDb, getSession, listSessions, updateSession, deleteSession,
  logEvent, getEvents, getChildren, getGroups, claimSession,
  createHost, getHost, listHosts, updateHost, mergeHostConfig, deleteHost,
  type Session, type Event, type Host,
} from "./store.js";

// Session lifecycle (the main API)
export {
  startSession, dispatch, advance, stop, resume, complete, pause,
  cloneSession, handoff, fork, joinFork, getOutput, send,
} from "./session.js";

// Pipeline
export * from "./pipeline.js";

// Agent
export { loadAgent, listAgents, saveAgent, deleteAgent, resolveAgent, buildClaudeArgs } from "./agent.js";

// Tmux
export * from "./tmux.js";

// Event bus
export * from "./hooks.js";

// Conductor
export { startConductor } from "./conductor.js";
