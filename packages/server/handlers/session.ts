import { Router } from "../router.js";
import * as core from "../../core/index.js";
import { ErrorCodes } from "../../protocol/types.js";

const SESSION_NOT_FOUND = ErrorCodes.SESSION_NOT_FOUND;

export function registerSessionHandlers(router: Router): void {
  // ── Session lifecycle ──────────────────────────────────────────────────────

  router.handle("session/start", async (params, notify) => {
    const session = core.startSession(params as any);
    notify("session/created", { session });
    return { session };
  });

  router.handle("session/dispatch", async (params, notify) => {
    const { sessionId } = params as { sessionId: string };
    const result = await core.dispatch(sessionId);
    const session = core.getSession(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/stop", async (params, notify) => {
    const { sessionId } = params as { sessionId: string };
    await core.stop(sessionId);
    const session = core.getSession(sessionId);
    if (session) notify("session/updated", { session });
    return { ok: true };
  });

  router.handle("session/advance", async (params, notify) => {
    const { sessionId, force } = params as { sessionId: string; force?: boolean };
    const result = await core.advance(sessionId, force ?? false);
    const session = core.getSession(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/complete", async (params, notify) => {
    const { sessionId } = params as { sessionId: string };
    await core.complete(sessionId);
    const session = core.getSession(sessionId);
    if (session) notify("session/updated", { session });
    return { ok: true };
  });

  router.handle("session/delete", async (params, notify) => {
    const { sessionId } = params as { sessionId: string };
    await core.deleteSessionAsync(sessionId);
    notify("session/deleted", { sessionId });
    return { ok: true };
  });

  router.handle("session/undelete", async (params, notify) => {
    const { sessionId } = params as { sessionId: string };
    const result = await core.undeleteSessionAsync(sessionId);
    const session = core.getSession(sessionId);
    if (session) notify("session/created", { session });
    return result;
  });

  router.handle("session/fork", async (params, notify) => {
    const { sessionId, name, group_name } = params as { sessionId: string; name?: string; group_name?: string };
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
    const { sessionId, name } = params as { sessionId: string; name?: string };
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
    const { sessionId, fields } = params as { sessionId: string; fields: Record<string, unknown> };
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
    const sessions = core.listSessions(params as any);
    return { sessions };
  });

  router.handle("session/read", async (params, _notify) => {
    const { sessionId, include } = params as { sessionId: string; include?: string[] };
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
    const { sessionId, limit } = params as { sessionId: string; limit?: number };
    const events = core.getEvents(sessionId, { limit });
    return { events };
  });

  router.handle("session/messages", async (params, _notify) => {
    const { sessionId, limit } = params as { sessionId: string; limit?: number };
    const messages = core.getMessages(sessionId, { limit });
    return { messages };
  });

  router.handle("session/search", async (params, _notify) => {
    const { query } = params as { query: string };
    const results = core.searchSessions(query);
    return { results };
  });

  router.handle("session/conversation", async (params, _notify) => {
    const { sessionId, limit } = params as { sessionId: string; limit?: number };
    const turns = core.getSessionConversation(sessionId, { limit });
    return { turns };
  });

  router.handle("session/search-conversation", async (params, _notify) => {
    const { sessionId, query } = params as { sessionId: string; query: string };
    const results = core.searchSessionConversation(sessionId, query);
    return { results };
  });

  router.handle("session/output", async (params, _notify) => {
    const { sessionId, lines } = params as { sessionId: string; lines?: number };
    const output = await core.getOutput(sessionId, { lines });
    return { output };
  });

  router.handle("session/handoff", async (params, notify) => {
    const { sessionId, agent, instructions } = params as { sessionId: string; agent: string; instructions?: string };
    const result = await core.handoff(sessionId, agent, instructions);
    const session = core.getSession(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/join", async (params, _notify) => {
    const { sessionId, force } = params as { sessionId: string; force?: boolean };
    const result = await core.joinFork(sessionId, force ?? false);
    return result;
  });

  router.handle("session/spawn", async (params, notify) => {
    const result = core.spawnSubagent(params.sessionId as string, {
      task: params.task as string,
      agent: params.agent as string | undefined,
      model: params.model as string | undefined,
      group_name: params.group_name as string | undefined,
    });
    if ((result as any).sessionId) {
      const session = core.getSession((result as any).sessionId);
      if (session) notify("session/created", { session });
    }
    return result;
  });

  router.handle("session/resume", async (params, notify) => {
    const { sessionId } = params as { sessionId: string };
    const result = await core.resume(sessionId);
    const session = core.getSession(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/pause", async (params, notify) => {
    const { sessionId, reason } = params as { sessionId: string; reason?: string };
    const result = core.pause(sessionId, reason);
    const session = core.getSession(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("worktree/finish", async (params, _notify) => {
    const { sessionId, noMerge } = params as { sessionId: string; noMerge?: boolean };
    const result = await core.finishWorktree(sessionId, { noMerge: noMerge ?? false });
    return result;
  });
}
