import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import { ErrorCodes } from "../../protocol/types.js";
import type {
  SessionIdParams,
  SessionStartParams,
  SessionDispatchParams,
  SessionAdvanceParams,
  SessionReadParams,
  SessionUpdateParams,
  SessionEventsParams,
  SessionMessagesParams,
  SessionSearchParams,
  SessionOutputParams,
  SessionHandoffParams,
  SessionJoinParams,
  SessionSpawnParams,
  SessionResumeParams,
  SessionPauseParams,
  SessionForkParams,
  SessionCloneParams,
  WorktreeFinishParams,
  SessionListParams,
} from "../../types/index.js";

const SESSION_NOT_FOUND = ErrorCodes.SESSION_NOT_FOUND;

export function registerSessionHandlers(router: Router, app: AppContext): void {
  // ── Session lifecycle ──────────────────────────────────────────────────────

  router.handle("session/start", async (params, notify) => {
    const opts = extract<SessionStartParams>(params, []);
    const session = core.startSession(opts as any);
    notify("session/created", { session });
    return { session };
  });

  router.handle("session/dispatch", async (params, notify) => {
    const { sessionId } = extract<SessionDispatchParams>(params, ["sessionId"]);
    const result = await core.dispatch(sessionId);
    const session = core.getSession(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/stop", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const result = await app.sessionService.stop(sessionId);
    if (result.ok) {
      const session = app.sessions.get(sessionId);
      if (session) notify("session/updated", { session });
    }
    return { ok: true };
  });

  router.handle("session/advance", async (params, notify) => {
    const { sessionId, force } = extract<SessionAdvanceParams>(params, ["sessionId"]);
    const result = await core.advance(sessionId, force ?? false);
    const session = core.getSession(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/complete", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    app.sessionService.complete(sessionId);
    const session = app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return { ok: true };
  });

  router.handle("session/delete", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    await app.sessionService.delete(sessionId);
    notify("session/deleted", { sessionId });
    return { ok: true };
  });

  router.handle("session/undelete", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const result = await app.sessionService.undelete(sessionId);
    const session = app.sessions.get(sessionId);
    if (session) notify("session/created", { session });
    return result;
  });

  router.handle("session/fork", async (params, notify) => {
    const { sessionId, name, group_name } = extract<SessionForkParams>(params, ["sessionId"]);
    const result = core.forkSession(sessionId, name);
    if (!result.ok) {
      const err = new Error((result as any).message);
      (err as any).code = SESSION_NOT_FOUND;
      throw err;
    }
    if (group_name) {
      core.updateSession(result.sessionId, { group_name });
    }
    const session = core.getSession(result.sessionId);
    if (session) notify("session/created", { session });
    return { session };
  });

  router.handle("session/clone", async (params, notify) => {
    const { sessionId, name } = extract<SessionCloneParams>(params, ["sessionId"]);
    const result = core.cloneSession(sessionId, name);
    if (!result.ok) {
      const err = new Error((result as any).message);
      (err as any).code = SESSION_NOT_FOUND;
      throw err;
    }
    const session = core.getSession(result.sessionId);
    if (session) notify("session/created", { session });
    return { session };
  });

  router.handle("session/update", async (params, notify) => {
    const { sessionId, fields } = extract<SessionUpdateParams>(params, ["sessionId", "fields"]);
    const existing = core.getSession(sessionId);
    if (!existing) {
      const err = new Error(`Session ${sessionId} not found`);
      (err as any).code = SESSION_NOT_FOUND;
      throw err;
    }
    core.updateSession(sessionId, fields as any);
    const session = core.getSession(sessionId);
    notify("session/updated", { session });
    return { session };
  });

  router.handle("session/list", async (params, _notify) => {
    const filters = extract<SessionListParams>(params, []);
    const sessions = core.listSessions(filters as any);
    return { sessions };
  });

  router.handle("session/read", async (params, _notify) => {
    const { sessionId, include } = extract<SessionReadParams>(params, ["sessionId"]);
    const session = core.getSession(sessionId);
    if (!session) {
      const err = new Error(`Session ${sessionId} not found`);
      (err as any).code = SESSION_NOT_FOUND;
      throw err;
    }
    const result: Record<string, unknown> = { session };
    if (include?.includes("events")) {
      result.events = core.getEvents(sessionId);
    }
    if (include?.includes("messages")) {
      result.messages = core.getMessages(sessionId);
    }
    return result;
  });

  // ── Queries ────────────────────────────────────────────────────────────────

  router.handle("session/events", async (params, _notify) => {
    const { sessionId, limit } = extract<SessionEventsParams>(params, ["sessionId"]);
    const events = core.getEvents(sessionId, { limit });
    return { events };
  });

  router.handle("session/messages", async (params, _notify) => {
    const { sessionId, limit } = extract<SessionMessagesParams>(params, ["sessionId"]);
    const messages = core.getMessages(sessionId, { limit });
    return { messages };
  });

  router.handle("session/search", async (params, _notify) => {
    const { query } = extract<SessionSearchParams>(params, ["query"]);
    const results = core.searchSessions(query);
    return { results };
  });

  router.handle("session/conversation", async (params, _notify) => {
    const { sessionId, limit } = extract<{ sessionId: string; limit?: number }>(params, ["sessionId"]);
    const turns = core.getSessionConversation(sessionId, { limit });
    return { turns };
  });

  router.handle("session/search-conversation", async (params, _notify) => {
    const { sessionId, query } = extract<{ sessionId: string; query: string }>(params, ["sessionId", "query"]);
    const results = core.searchSessionConversation(sessionId, query);
    return { results };
  });

  router.handle("session/output", async (params, _notify) => {
    const { sessionId, lines } = extract<SessionOutputParams>(params, ["sessionId"]);
    const output = await core.getOutput(sessionId, { lines });
    return { output };
  });

  router.handle("session/handoff", async (params, notify) => {
    const { sessionId, agent, instructions } = extract<SessionHandoffParams>(params, ["sessionId", "agent"]);
    const result = await core.handoff(sessionId, agent, instructions);
    const session = core.getSession(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/join", async (params, _notify) => {
    const { sessionId, force } = extract<SessionJoinParams>(params, ["sessionId"]);
    const result = await core.joinFork(sessionId, force ?? false);
    return result;
  });

  router.handle("session/spawn", async (params, notify) => {
    const { sessionId, task, agent, model, group_name } = extract<SessionSpawnParams>(params, ["sessionId", "task"]);
    const result = core.spawnSubagent(sessionId, {
      task,
      agent,
      model,
      group_name,
    });
    if ((result as any).sessionId) {
      const session = core.getSession((result as any).sessionId);
      if (session) notify("session/created", { session });
    }
    return result;
  });

  router.handle("session/resume", async (params, notify) => {
    const { sessionId } = extract<SessionResumeParams>(params, ["sessionId"]);
    const result = await app.sessionService.resume(sessionId);
    const session = app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/pause", async (params, notify) => {
    const { sessionId, reason } = extract<SessionPauseParams>(params, ["sessionId"]);
    const result = app.sessionService.pause(sessionId, reason);
    const session = app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("worktree/finish", async (params, _notify) => {
    const { sessionId, noMerge } = extract<WorktreeFinishParams>(params, ["sessionId"]);
    const result = await core.finishWorktree(sessionId, { noMerge: noMerge ?? false });
    return result;
  });
}
