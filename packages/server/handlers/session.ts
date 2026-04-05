import { Router } from "../router.js";
import * as core from "../../core/index.js";

const SESSION_NOT_FOUND = -32002;

export function registerSessionHandlers(router: Router): void {
  // ── Session lifecycle ──────────────────────────────────────────────────────

  router.handle("session/start", async (params) => {
    const session = core.startSession(params as any);
    return { session };
  });

  router.handle("session/dispatch", async (params) => {
    const { sessionId } = params as { sessionId: string };
    const result = await core.dispatch(sessionId);
    return result;
  });

  router.handle("session/stop", async (params) => {
    const { sessionId } = params as { sessionId: string };
    await core.stop(sessionId);
    return { ok: true };
  });

  router.handle("session/advance", async (params) => {
    const { sessionId, force } = params as { sessionId: string; force?: boolean };
    const result = await core.advance(sessionId, force ?? false);
    return result;
  });

  router.handle("session/complete", async (params) => {
    const { sessionId } = params as { sessionId: string };
    await core.complete(sessionId);
    return { ok: true };
  });

  router.handle("session/delete", async (params) => {
    const { sessionId } = params as { sessionId: string };
    await core.deleteSessionAsync(sessionId);
    return { ok: true };
  });

  router.handle("session/undelete", async (params) => {
    const { sessionId } = params as { sessionId: string };
    const result = await core.undeleteSessionAsync(sessionId);
    return result;
  });

  router.handle("session/fork", async (params) => {
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
    return { session };
  });

  router.handle("session/clone", async (params) => {
    const { sessionId, name } = params as { sessionId: string; name?: string };
    const result = core.cloneSession(sessionId, name);
    if (!result.ok) {
      const err = new Error((result as any).message);
      (err as any).code = SESSION_NOT_FOUND;
      throw err;
    }
    const session = core.getSession(result.sessionId);
    return { session };
  });

  router.handle("session/update", async (params) => {
    const { sessionId, fields } = params as { sessionId: string; fields: Record<string, unknown> };
    const existing = core.getSession(sessionId);
    if (!existing) {
      const err = new Error(`Session ${sessionId} not found`);
      (err as any).code = SESSION_NOT_FOUND;
      throw err;
    }
    core.updateSession(sessionId, fields as any);
    const session = core.getSession(sessionId);
    return { session };
  });

  router.handle("session/list", async (_params) => {
    const sessions = core.listSessions();
    return { sessions };
  });

  router.handle("session/read", async (params) => {
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

  router.handle("session/events", async (params) => {
    const { sessionId, limit } = params as { sessionId: string; limit?: number };
    const events = core.getEvents(sessionId, limit);
    return { events };
  });

  router.handle("session/messages", async (params) => {
    const { sessionId, limit } = params as { sessionId: string; limit?: number };
    const messages = core.getMessages(sessionId, { limit });
    return { messages };
  });

  router.handle("session/search", async (params) => {
    const { query } = params as { query: string };
    const results = core.searchSessions(query);
    return { results };
  });

  router.handle("session/conversation", async (params) => {
    const { sessionId, limit } = params as { sessionId: string; limit?: number };
    const turns = core.getSessionConversation(sessionId, { limit });
    return { turns };
  });
}
