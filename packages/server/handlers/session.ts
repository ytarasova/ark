import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { searchSessions, getSessionConversation, searchSessionConversation } from "../../core/search/search.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
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
    // Use orchestration startSession which resolves first stage and sets status=ready.
    // SessionService.start() is a stripped-down helper that doesn't wire the flow.
    const { startSession } = await import("../../core/services/session-orchestration.js");
    const session = startSession(app, opts);
    notify("session/created", { session });
    return { session };
  });

  router.handle("session/dispatch", async (params, notify) => {
    const { sessionId } = extract<SessionDispatchParams>(params, ["sessionId"]);
    const result = await app.sessionService.dispatch(sessionId);
    const session = app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/stop", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const result = await app.sessionService.stop(sessionId);
    if (!result.ok) throw new RpcError(result.message ?? "Stop failed", SESSION_NOT_FOUND);
    const session = app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/advance", async (params, notify) => {
    const { sessionId, force } = extract<SessionAdvanceParams>(params, ["sessionId"]);
    const result = await app.sessionService.advance(sessionId, force ?? false);
    const session = app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/complete", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const result = app.sessionService.complete(sessionId);
    if (!result.ok) throw new RpcError(result.message ?? "Complete failed", SESSION_NOT_FOUND);
    const session = app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
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
    const result = await app.sessionService.fork(sessionId, name);
    if (!result.ok) {
      throw new RpcError(result.message, SESSION_NOT_FOUND);
    }
    if (group_name && result.sessionId) {
      app.sessions.update(result.sessionId, { group_name });
    }
    const session = result.sessionId ? app.sessions.get(result.sessionId) : null;
    if (session) notify("session/created", { session });
    return { session };
  });

  router.handle("session/clone", async (params, notify) => {
    const { sessionId, name } = extract<SessionCloneParams>(params, ["sessionId"]);
    const result = await app.sessionService.clone(sessionId, name);
    if (!result.ok) {
      throw new RpcError(result.message, SESSION_NOT_FOUND);
    }
    const session = result.sessionId ? app.sessions.get(result.sessionId) : null;
    if (session) notify("session/created", { session });
    return { session };
  });

  router.handle("session/update", async (params, notify) => {
    const { sessionId, fields } = extract<SessionUpdateParams>(params, ["sessionId", "fields"]);
    const existing = app.sessions.get(sessionId);
    if (!existing) {
      throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    }
    app.sessions.update(sessionId, fields);
    const session = app.sessions.get(sessionId);
    notify("session/updated", { session });
    return { session };
  });

  router.handle("session/list", async (params, _notify) => {
    const filters = extract<SessionListParams>(params, []);
    const sessions = app.sessions.list(filters);
    return { sessions };
  });

  router.handle("session/read", async (params, _notify) => {
    const { sessionId, include } = extract<SessionReadParams>(params, ["sessionId"]);
    const session = app.sessions.get(sessionId);
    if (!session) {
      throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    }
    const result: Record<string, unknown> = { session };
    if (include?.includes("events")) {
      result.events = app.events.list(sessionId);
    }
    if (include?.includes("messages")) {
      result.messages = app.messages.list(sessionId);
    }
    return result;
  });

  // ── Queries ────────────────────────────────────────────────────────────────

  router.handle("session/events", async (params, _notify) => {
    const { sessionId, limit } = extract<SessionEventsParams>(params, ["sessionId"]);
    const events = app.events.list(sessionId, { limit });
    return { events };
  });

  router.handle("session/messages", async (params, _notify) => {
    const { sessionId, limit } = extract<SessionMessagesParams>(params, ["sessionId"]);
    const messages = app.messages.list(sessionId, { limit });
    return { messages };
  });

  router.handle("session/search", async (params, _notify) => {
    const { query } = extract<SessionSearchParams>(params, ["query"]);
    const results = searchSessions(app, query);
    return { results };
  });

  router.handle("session/conversation", async (params, _notify) => {
    const { sessionId, limit } = extract<{ sessionId: string; limit?: number }>(params, ["sessionId"]);
    const turns = getSessionConversation(app, sessionId, { limit });
    return { turns };
  });

  router.handle("session/search-conversation", async (params, _notify) => {
    const { sessionId, query } = extract<{ sessionId: string; query: string }>(params, ["sessionId", "query"]);
    const results = searchSessionConversation(app, sessionId, query);
    return { results };
  });

  router.handle("session/output", async (params, _notify) => {
    const { sessionId, lines } = extract<SessionOutputParams>(params, ["sessionId"]);
    const output = await app.sessionService.getOutput(sessionId, { lines });
    return { output };
  });

  router.handle("session/handoff", async (params, notify) => {
    const { sessionId, agent, instructions } = extract<SessionHandoffParams>(params, ["sessionId", "agent"]);
    const result = await app.sessionService.handoff(sessionId, agent, instructions);
    const session = app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/join", async (params, _notify) => {
    const { sessionId, force } = extract<SessionJoinParams>(params, ["sessionId"]);
    const result = await app.sessionService.join(sessionId, force ?? false);
    return result;
  });

  router.handle("session/spawn", async (params, notify) => {
    const { sessionId, task, agent, model, group_name } = extract<SessionSpawnParams>(params, ["sessionId", "task"]);
    const result = await app.sessionService.spawn(sessionId, {
      task,
      agent,
      model,
      group_name,
    });
    if (result.sessionId) {
      const session = app.sessions.get(result.sessionId);
      if (session) notify("session/created", { session });
    }
    return result;
  });

  router.handle("session/fan-out", async (params, notify) => {
    const { sessionId, tasks } = extract<{ sessionId: string; tasks: Array<{ summary: string; agent?: string; flow?: string }> }>(params, ["sessionId", "tasks"]);
    const result = await app.sessionService.fanOut(sessionId, { tasks });
    if (!result.ok) throw new RpcError(result.message ?? "Fan-out failed", SESSION_NOT_FOUND);
    for (const childId of result.childIds ?? []) {
      const session = app.sessions.get(childId);
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

  router.handle("session/interrupt", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const result = await app.sessionService.interrupt(sessionId);
    const session = app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/archive", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const result = await app.sessionService.archive(sessionId);
    if (result.ok) notify("session/updated", { session: app.sessions.get(sessionId) });
    return result;
  });

  router.handle("session/restore", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const result = await app.sessionService.restore(sessionId);
    if (result.ok) notify("session/updated", { session: app.sessions.get(sessionId) });
    return result;
  });

  router.handle("worktree/diff", async (params) => {
    const { sessionId, base } = extract<{ sessionId: string; base?: string }>(params, ["sessionId"]);
    return app.sessionService.worktreeDiff(sessionId, { base });
  });

  router.handle("worktree/create-pr", async (params, notify) => {
    const { sessionId, title, body, base, draft } = extract<{ sessionId: string; title?: string; body?: string; base?: string; draft?: boolean }>(params, ["sessionId"]);
    const result = await app.sessionService.createWorktreePR(sessionId, { title, body, base, draft });
    const session = app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("worktree/finish", async (params, _notify) => {
    const { sessionId, noMerge, createPR } = extract<WorktreeFinishParams>(params, ["sessionId"]);
    const result = await app.sessionService.finishWorktree(sessionId, { noMerge: noMerge ?? false, createPR: createPR ?? false });
    return result;
  });

  // ── Todos ────────────────────────────────────────────────────────────────

  router.handle("todo/list", async (params) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    return { todos: app.todos.list(sessionId) };
  });

  router.handle("todo/add", async (params) => {
    const { sessionId, content } = extract<{ sessionId: string; content: string }>(params, ["sessionId", "content"]);
    return { todo: app.todos.add(sessionId, content) };
  });

  router.handle("todo/toggle", async (params) => {
    const { id } = extract<{ id: number }>(params, ["id"]);
    const todo = app.todos.toggle(id);
    return { todo };
  });

  router.handle("todo/delete", async (params) => {
    const { id } = extract<{ id: number }>(params, ["id"]);
    return { ok: app.todos.delete(id) };
  });

  // ── Verification ─────────────────────────────────────────────────────────

  router.handle("verify/run", async (params) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const { runVerification } = await import("../../core/services/session-orchestration.js");
    return runVerification(app, sessionId);
  });

  // ── Export ─────────────────────────────────────────────────────────────

  router.handle("session/export", async (params) => {
    const { sessionId, filePath } = extract<{ sessionId: string; filePath?: string }>(params, ["sessionId"]);
    const { exportSession, exportSessionToFile } = await import("../../core/session/share.js");
    if (filePath) {
      const ok = exportSessionToFile(app, sessionId, filePath);
      return { ok, filePath };
    }
    const data = exportSession(app, sessionId);
    if (!data) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    return { ok: true, data };
  });

  // ── Artifact tracking ──────────────────────────────────────────────────────

  router.handle("session/artifacts/list", async (params) => {
    const { sessionId, type } = extract<{ sessionId: string; type?: string }>(params, ["sessionId"]);
    const artifacts = app.artifacts.list(sessionId, type as any);
    return { artifacts };
  });

  router.handle("session/artifacts/query", async (params) => {
    const q = extract<{ session_id?: string; type?: string; value?: string; limit?: number }>(params, []);
    const artifacts = app.artifacts.query(q as any);
    return { artifacts };
  });
}
