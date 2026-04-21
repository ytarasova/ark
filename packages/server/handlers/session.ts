import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { searchSessions, getSessionConversation, searchSessionConversation } from "../../core/search/search.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import type {
  SessionIdParams,
  SessionStartParams,
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
    // Atomic create + dispatch: splitting these across two RPCs used to force
    // every caller (CLI, web, tests) to remember the second call or live with
    // a session stuck at status=ready until the conductor's 60s poll tick.
    //
    // `startSession` emits `session_created` before returning; the default
    // dispatcher listener (registered above) kicks the background launcher.
    const { startSession } = await import("../../core/services/session-orchestration.js");
    const session = startSession(app, opts);
    notify("session/created", { session });
    return { session };
  });

  router.handle("input/upload", async (params) => {
    const opts = extract<{
      name: string;
      role: string;
      content: string;
      contentEncoding?: "base64" | "utf-8";
    }>(params, ["name", "role", "content"]);
    return app.sessionService.saveInput(opts);
  });

  router.handle("input/read", async (params) => {
    const { locator } = extract<{ locator: string }>(params, ["locator"]);
    const { LOCAL_TENANT_ID } = await import("../../core/storage/blob-store.js");
    const { bytes, meta } = await app.blobStore.get(locator, app.tenantId ?? LOCAL_TENANT_ID);
    return {
      filename: meta.filename,
      contentType: meta.contentType ?? "application/octet-stream",
      content: bytes.toString("base64"),
      contentEncoding: "base64",
      size: meta.size,
    };
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
    const sessForLog = await app.sessions.get(sessionId);
    app.events.log(sessionId, "stage_advanced", {
      actor: "user",
      stage: sessForLog?.stage ?? undefined,
      data: { force: force ?? false },
    });
    const result = await app.sessionService.advance(sessionId, force ?? false);
    const session = await app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/complete", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const result = await app.sessionService.complete(sessionId);
    if (!result.ok) throw new RpcError(result.message ?? "Complete failed", SESSION_NOT_FOUND);
    // Advance the flow after completing the stage -- without this, sessions
    // get stuck at "ready" instead of progressing to the next stage or "completed".
    await app.sessionService.advance(sessionId, true);
    const session = await app.sessions.get(sessionId);
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

  router.handle("session/recording", async (params, _notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const { readRecording } = await import("../../core/recordings.js");
    const output = readRecording(app.config.arkDir, sessionId);
    return { ok: output !== null, output };
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
      // spawn() emits session_created internally; the default listener handles dispatch.
    }
    return result;
  });

  router.handle("session/fan-out", async (params, notify) => {
    const { sessionId, tasks } = extract<{
      sessionId: string;
      tasks: Array<{ summary: string; agent?: string; flow?: string }>;
    }>(params, ["sessionId", "tasks"]);
    const result = await app.sessionService.fanOut(sessionId, { tasks });
    if (!result.ok) throw new RpcError(result.message ?? "Fan-out failed", SESSION_NOT_FOUND);
    for (const childId of result.childIds ?? []) {
      const session = app.sessions.get(childId);
      if (session) notify("session/created", { session });
    }
    // Fan-out children are dispatched en masse by the orchestrator (see
    // stage-orchestrator.ts:1252). No need to loop here.
    return result;
  });

  router.handle("session/resume", async (params, notify) => {
    const { sessionId, snapshotId } = extract<SessionResumeParams>(params, ["sessionId"]);

    // If the session has a persisted snapshot (or the caller supplied one
    // explicitly), prefer the snapshot-based restore path. Otherwise fall
    // back to the state-only resume for backends that don't snapshot.
    const session = await app.sessions.get(sessionId);
    const lastSnapshotId =
      snapshotId ?? (session?.config as Record<string, unknown> | undefined)?.last_snapshot_id ?? undefined;

    if (lastSnapshotId) {
      const { resumeFromSnapshot } = await import("../../core/services/session-snapshot.js");
      const snapResult = await resumeFromSnapshot(app, sessionId, { snapshotId: lastSnapshotId as string });
      if (snapResult.ok) {
        const updated = await app.sessions.get(sessionId);
        if (updated) notify("session/updated", { session: updated });
        return { ok: true, message: snapResult.message, snapshotId: snapResult.snapshotId };
      }
      // Fall through to state-only resume only when the failure is because the
      // compute doesn't support restore -- other errors (missing snapshot,
      // restore failure) should surface so the caller sees them.
      if (!snapResult.notSupported) {
        throw new RpcError(snapResult.message, SESSION_NOT_FOUND);
      }
    }

    const result = await app.sessionService.resume(sessionId);
    const updated = app.sessions.get(sessionId);
    if (updated) notify("session/updated", { session: updated });
    return result;
  });

  router.handle("session/pause", async (params, notify) => {
    const { sessionId, reason } = extract<SessionPauseParams>(params, ["sessionId"]);

    // Try the snapshot-backed pause first. If the underlying compute doesn't
    // support snapshot we transparently fall back to a state-only pause so
    // local sessions keep working the way they did before snapshotting.
    const { pauseWithSnapshot } = await import("../../core/services/session-snapshot.js");
    const snapResult = await pauseWithSnapshot(app, sessionId, { reason });
    const session = app.sessions.get(sessionId);

    if (snapResult.ok) {
      if (session) notify("session/updated", { session });
      return { ok: true, message: snapResult.message, snapshot: snapResult.snapshot };
    }
    if (!snapResult.notSupported) {
      // Snapshot path failed for reasons other than capability -- surface.
      throw new RpcError(snapResult.message, SESSION_NOT_FOUND);
    }

    // Fallback: state-only pause (pre-Phase-3 behaviour).
    const result = app.sessionService.pause(sessionId, reason);
    const updated = app.sessions.get(sessionId);
    if (updated) notify("session/updated", { session: updated });
    return { ...result, snapshot: null, notSupported: true };
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
    const { sessionId, title, body, base, draft } = extract<{
      sessionId: string;
      title?: string;
      body?: string;
      base?: string;
      draft?: boolean;
    }>(params, ["sessionId"]);
    const result = await app.sessionService.createWorktreePR(sessionId, { title, body, base, draft });
    const session = app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("worktree/finish", async (params, _notify) => {
    const { sessionId, noMerge, createPR } = extract<WorktreeFinishParams>(params, ["sessionId"]);
    const result = await app.sessionService.finishWorktree(sessionId, {
      noMerge: noMerge ?? false,
      createPR: createPR ?? false,
    });
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

  // ── Replay ──────────────────────────────────────────────────────────────────

  router.handle("session/replay", async (params) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const { buildReplay } = await import("../../core/session/replay.js");
    const steps = buildReplay(app, sessionId);
    return { steps };
  });
}
