import { promises as fsPromises } from "fs";
import { join } from "path";
import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { searchSessions, getSessionConversation, searchSessionConversation } from "../../core/search/search.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { resolveTenantApp } from "./scope-helpers.js";
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

  router.handle("session/start", async (params, notify, ctx) => {
    const opts = extract<SessionStartParams>(params, []);
    const scoped = resolveTenantApp(app, ctx);

    // Flow-level requires_repo gate (#416). Code-modifying flows declare
    // `requires_repo: true`; reject the dispatch up-front when no repo is
    // pinned, instead of silently landing the session in an empty worktree
    // where the agent has nothing to plan against. Inline flows always
    // accept (tests + dynamic dispatch); only registered flow names are
    // validated here.
    const flowName = typeof opts.flow === "string" ? opts.flow : null;
    if (flowName && !opts.repo) {
      const flow = scoped.flows.get(flowName);
      if (flow?.requires_repo) {
        throw new RpcError(
          `Flow '${flowName}' requires a repo. Pass repo: <git-url-or-local-path>.`,
          ErrorCodes.INVALID_PARAMS,
        );
      }
    }

    // Atomic create + dispatch: splitting these across two RPCs used to force
    // every caller (CLI, web, tests) to remember the second call or live with
    // a session stuck at status=ready until the conductor's 60s poll tick.
    //
    // `start()` emits `session_created` before returning; the default
    // dispatcher listener (registered above) kicks the background launcher.
    const session = await scoped.sessionLifecycle.start(opts, {
      onCreated: (id) => scoped.sessionService.emitSessionCreated(id),
    });
    notify("session/created", { session });
    return { session };
  });

  router.handle("input/upload", async (params, _notify, ctx) => {
    const opts = extract<{
      name: string;
      role: string;
      content: string;
      contentEncoding?: "base64" | "utf-8";
    }>(params, ["name", "role", "content"]);
    const scoped = resolveTenantApp(app, ctx);
    return scoped.sessionService.saveInput(opts);
  });

  router.handle("input/read", async (params, _notify, ctx) => {
    const { locator } = extract<{ locator: string }>(params, ["locator"]);
    const scoped = resolveTenantApp(app, ctx);
    const { LOCAL_TENANT_ID } = await import("../../core/storage/blob-store.js");
    // `app.blobStore` is not re-registered per tenant (no SCOPED variant in
    // buildTenantScope), so resolve through the root handle but pass the
    // tenant-scoped id so the stored blob is isolated.
    const { bytes, meta } = await app.blobStore.get(locator, scoped.tenantId ?? LOCAL_TENANT_ID);
    return {
      filename: meta.filename,
      contentType: meta.contentType ?? "application/octet-stream",
      content: bytes.toString("base64"),
      contentEncoding: "base64",
      size: meta.size,
    };
  });

  router.handle("session/stop", async (params, notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.stop(sessionId);
    if (!result.ok) throw new RpcError(result.message ?? "Stop failed", SESSION_NOT_FOUND);
    const session = await scoped.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/advance", async (params, notify, ctx) => {
    const { sessionId, force } = extract<SessionAdvanceParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const sessForLog = await scoped.sessions.get(sessionId);
    await scoped.events.log(sessionId, "stage_advanced", {
      actor: "user",
      stage: sessForLog?.stage ?? undefined,
      data: { force: force ?? false },
    });
    const result = await scoped.sessionService.advance(sessionId, force ?? false);
    const session = await scoped.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/complete", async (params, notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.complete(sessionId);
    if (!result.ok) throw new RpcError(result.message ?? "Complete failed", SESSION_NOT_FOUND);
    // Advance the flow after completing the stage -- without this, sessions
    // get stuck at "ready" instead of progressing to the next stage or "completed".
    await scoped.sessionService.advance(sessionId, true);
    const session = await scoped.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/delete", async (params, notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    await scoped.sessionService.delete(sessionId);
    notify("session/deleted", { sessionId });
    return { ok: true };
  });

  router.handle("session/undelete", async (params, notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.undelete(sessionId);
    const session = await scoped.sessions.get(sessionId);
    if (session) notify("session/created", { session });
    return result;
  });

  router.handle("session/fork", async (params, notify, ctx) => {
    const { sessionId, name, group_name } = extract<SessionForkParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.fork(sessionId, name);
    if (!result.ok) {
      throw new RpcError(result.message, SESSION_NOT_FOUND);
    }
    if (group_name && result.sessionId) {
      await scoped.sessions.update(result.sessionId, { group_name });
    }
    const session = result.sessionId ? await scoped.sessions.get(result.sessionId) : null;
    if (session) notify("session/created", { session });
    return { session };
  });

  router.handle("session/clone", async (params, notify, ctx) => {
    const { sessionId, name } = extract<SessionCloneParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.clone(sessionId, name);
    if (!result.ok) {
      throw new RpcError(result.message, SESSION_NOT_FOUND);
    }
    const session = result.sessionId ? await scoped.sessions.get(result.sessionId) : null;
    if (session) notify("session/created", { session });
    return { session };
  });

  router.handle("session/update", async (params, notify, ctx) => {
    const { sessionId, fields } = extract<SessionUpdateParams>(params, ["sessionId", "fields"]);
    const scoped = resolveTenantApp(app, ctx);
    const existing = await scoped.sessions.get(sessionId);
    if (!existing) {
      throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    }
    await scoped.sessions.update(sessionId, fields);
    const session = await scoped.sessions.get(sessionId);
    notify("session/updated", { session });
    return { session };
  });

  router.handle("session/list", async (params, _notify, ctx) => {
    const filters = extract<SessionListParams>(params, []);
    const scoped = resolveTenantApp(app, ctx);
    // rootsOnly switches to the tree-aware path so every row carries a
    // `child_stats` rollup. Flat behaviour is preserved when unset/false.
    if (filters?.rootsOnly) {
      const sessions = await scoped.sessions.listRoots(filters);
      return { sessions };
    }
    const sessions = await scoped.sessions.list(filters);
    return { sessions };
  });

  router.handle("session/list_children", async (params, _notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const sessions = await scoped.sessions.listChildren(sessionId);
    return { sessions };
  });

  router.handle("session/tree", async (params, _notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const existing = await scoped.sessions.get(sessionId);
    if (!existing) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    try {
      const root = await scoped.sessions.loadTree(sessionId);
      return { root };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // Bubble the parent-required error as a clean RpcError so the UI can
      // show an actionable message without relying on string matching.
      throw new RpcError(msg, SESSION_NOT_FOUND);
    }
  });

  router.handle("session/read", async (params, _notify, ctx) => {
    const { sessionId, include } = extract<SessionReadParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const session = await scoped.sessions.get(sessionId);
    if (!session) {
      throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    }
    const result: Record<string, unknown> = { session };
    if (include?.includes("events")) {
      result.events = await scoped.events.list(sessionId);
    }
    if (include?.includes("messages")) {
      result.messages = await scoped.messages.list(sessionId);
    }
    return result;
  });

  // ── Queries ────────────────────────────────────────────────────────────────

  router.handle("session/events", async (params, _notify, ctx) => {
    const { sessionId, limit } = extract<SessionEventsParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const events = await scoped.events.list(sessionId, { limit });
    return { events };
  });

  router.handle("session/messages", async (params, _notify, ctx) => {
    const { sessionId, limit } = extract<SessionMessagesParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const messages = await scoped.messages.list(sessionId, { limit });
    return { messages };
  });

  router.handle("session/search", async (params, _notify, ctx) => {
    const { query } = extract<SessionSearchParams>(params, ["query"]);
    const scoped = resolveTenantApp(app, ctx);
    const results = await searchSessions(scoped, query);
    return { results };
  });

  router.handle("session/conversation", async (params, _notify, ctx) => {
    const { sessionId, limit } = extract<{ sessionId: string; limit?: number }>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const turns = await getSessionConversation(scoped, sessionId, { limit });
    return { turns };
  });

  router.handle("session/search-conversation", async (params, _notify, ctx) => {
    const { sessionId, query } = extract<{ sessionId: string; query: string }>(params, ["sessionId", "query"]);
    const scoped = resolveTenantApp(app, ctx);
    const results = await searchSessionConversation(scoped, sessionId, query);
    return { results };
  });

  router.handle("session/output", async (params, _notify, ctx) => {
    const { sessionId, lines } = extract<SessionOutputParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const output = await scoped.sessionService.getOutput(sessionId, { lines });
    return { output };
  });

  // ── Forensic files (tracks/<id>/stdio.log + transcript.jsonl) ────────────
  //
  // Both methods 404 when the session is missing, return empty content when
  // the file doesn't exist, and enforce the same 2MB cap as the REST routes.
  // `session/stdio` honours an optional `tail` to slice the trailing N lines.

  router.handle("session/stdio", async (params, _notify, ctx) => {
    const { sessionId, tail } = extract<{ sessionId: string; tail?: number }>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const session = await scoped.sessions.get(sessionId);
    if (!session) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    const { readForensicFile } = await import("../../core/services/session-forensic.js");
    // Forensic files live under the daemon's tracks dir (not per-tenant on
    // disk). Access control is via the tenant-scoped sessions lookup above.
    const read = await readForensicFile(scoped.config.dirs.tracks, sessionId, "stdio.log", { tail });
    if (read.tooLarge) {
      throw new RpcError(
        `stdio.log is ${read.size} bytes, over the 2MB cap -- pass tail=<N> to read the tail`,
        ErrorCodes.INVALID_PARAMS,
      );
    }
    return { content: read.content, size: read.size, exists: read.exists };
  });

  router.handle("session/transcript", async (params, _notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const session = await scoped.sessions.get(sessionId);
    if (!session) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    const { readForensicFile, parseJsonl } = await import("../../core/services/session-forensic.js");
    const read = await readForensicFile(scoped.config.dirs.tracks, sessionId, "transcript.jsonl");
    if (read.tooLarge) {
      throw new RpcError(`transcript.jsonl is ${read.size} bytes, over the 2MB cap`, ErrorCodes.INVALID_PARAMS);
    }
    return { messages: parseJsonl(read.content), size: read.size, exists: read.exists };
  });

  router.handle("session/recording", async (params, _notify, _ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const { readRecording } = await import("../../core/recordings.js");
    // Recording files live in the daemon's arkDir (not tenant-segmented).
    const output = readRecording(app.config.dirs.ark, sessionId);
    return { ok: output !== null, output };
  });

  router.handle("session/handoff", async (params, notify, ctx) => {
    const { sessionId, agent, instructions } = extract<SessionHandoffParams>(params, ["sessionId", "agent"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.handoff(sessionId, agent, instructions);
    const session = await scoped.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/join", async (params, _notify, ctx) => {
    const { sessionId, force } = extract<SessionJoinParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.join(sessionId, force ?? false);
    return result;
  });

  router.handle("session/spawn", async (params, notify, ctx) => {
    const { sessionId, task, agent, group_name } = extract<SessionSpawnParams>(params, ["sessionId", "task"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.spawn(sessionId, {
      task,
      agent,
      group_name,
    });
    if (result.sessionId) {
      const session = await scoped.sessions.get(result.sessionId);
      if (session) notify("session/created", { session });
      // spawn() emits session_created internally; the default listener handles dispatch.
    }
    return result;
  });

  router.handle("session/fan-out", async (params, notify, ctx) => {
    const { sessionId, tasks } = extract<{
      sessionId: string;
      tasks: Array<{ summary: string; agent?: string; flow?: string }>;
    }>(params, ["sessionId", "tasks"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.fanOut(sessionId, { tasks });
    if (!result.ok) throw new RpcError(result.message ?? "Fan-out failed", SESSION_NOT_FOUND);
    for (const childId of result.childIds ?? []) {
      const session = await scoped.sessions.get(childId);
      if (session) notify("session/created", { session });
    }
    // Fan-out children are dispatched en masse by the orchestrator (see
    // stage-orchestrator.ts:1252). No need to loop here.
    return result;
  });

  router.handle("session/resume", async (params, notify, ctx) => {
    const { sessionId, snapshotId, rewindToStage } = extract<SessionResumeParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);

    // Snapshot-backed restore bypasses rewind: restoring a pinned snapshot is
    // a different operation from "re-run from stage X". If the caller wants
    // a rewind, they must not also ask for a snapshot.
    const session = await scoped.sessions.get(sessionId);
    const lastSnapshotId =
      snapshotId ?? (session?.config as Record<string, unknown> | undefined)?.last_snapshot_id ?? undefined;

    if (lastSnapshotId && !rewindToStage) {
      const { resumeFromSnapshot } = await import("../../core/services/session-snapshot.js");
      const snapResult = await resumeFromSnapshot(scoped, sessionId, { snapshotId: lastSnapshotId as string });
      if (snapResult.ok) {
        const updated = await scoped.sessions.get(sessionId);
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

    const result = await scoped.sessionService.resume(sessionId, { rewindToStage });
    const updated = await scoped.sessions.get(sessionId);
    if (updated) notify("session/updated", { session: updated });
    return result;
  });

  router.handle("session/flowStages", async (params, _notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const session = await scoped.sessions.get(sessionId);
    if (!session) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    const { getStages } = await import("../../core/state/flow.js");
    const stages = getStages(scoped, session.flow).map((s) => ({
      name: s.name,
      type: s.action ? "action" : s.agent ? "agent" : (s.type ?? "agent"),
      agent: s.agent ?? null,
      action: s.action ?? null,
    }));
    return { flow: session.flow, currentStage: session.stage, stages };
  });

  router.handle("session/pause", async (params, notify, ctx) => {
    const { sessionId, reason } = extract<SessionPauseParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);

    // Try the snapshot-backed pause first. If the underlying compute doesn't
    // support snapshot we transparently fall back to a state-only pause so
    // local sessions keep working the way they did before snapshotting.
    const { pauseWithSnapshot } = await import("../../core/services/session-snapshot.js");
    const snapResult = await pauseWithSnapshot(scoped, sessionId, { reason });
    const session = await scoped.sessions.get(sessionId);

    if (snapResult.ok) {
      if (session) notify("session/updated", { session });
      return { ok: true, message: snapResult.message, snapshot: snapResult.snapshot };
    }
    if (!snapResult.notSupported) {
      // Snapshot path failed for reasons other than capability -- surface.
      throw new RpcError(snapResult.message, SESSION_NOT_FOUND);
    }

    // Fallback: state-only pause (pre-Phase-3 behaviour).
    const result = await scoped.sessionService.pause(sessionId, reason);
    const updated = await scoped.sessions.get(sessionId);
    if (updated) notify("session/updated", { session: updated });
    return { ...result, snapshot: null, notSupported: true };
  });

  router.handle("session/interrupt", async (params, _notify, ctx) => {
    const { sessionId, content } = extract<{ sessionId: string; content: string }>(params, ["sessionId", "content"]);
    const scoped = resolveTenantApp(app, ctx);

    const s = await scoped.sessions.get(sessionId);
    if (!s) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    if (s.status !== "running") {
      return { ok: false, message: `session not running (status=${s.status})` };
    }

    // claude-agent sessions use file-tail IPC via interventions.jsonl.
    // Writing control:"interrupt" causes launch.ts to abort the current turn
    // and resume with options.resume = <sdkSessionId>. The content is pushed
    // into the prompt queue as the correction message for the next turn.
    // Persisted sessions may carry the legacy `agent-sdk` executor name.
    const executorName = (s.config as Record<string, unknown> | null)?.launch_executor as string | undefined;
    if (executorName === "claude-agent" || executorName === "agent-sdk") {
      const sessionDir = join(scoped.config.dirs.tracks, sessionId);
      const interventionPath = join(sessionDir, "interventions.jsonl");
      await fsPromises.mkdir(sessionDir, { recursive: true });
      const line = JSON.stringify({ role: "user", content, control: "interrupt", ts: Date.now() }) + "\n";
      await fsPromises.appendFile(interventionPath, line, "utf8");

      await scoped.events.log(sessionId, "session_interrupted", {
        actor: "user",
        data: { content_preview: content.slice(0, 80) },
      });

      return { ok: true };
    }

    // Non-claude-agent sessions: fall back to the tmux C-c interrupt.
    const result = await scoped.sessionLifecycle.interrupt(sessionId);
    return result;
  });

  // ── session/kill -- hard terminate, no grace ──────────────────────────────
  //
  // Goes straight to SIGKILL (skips the SIGTERM grace that session/stop uses).
  // Marks session `failed` with reason `killed` and runs D2 cleanup
  // synchronously so post-conditions are reliable for the caller.

  router.handle("session/kill", async (params, notify, ctx) => {
    const { sessionId } = extract<{ sessionId: string }>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);

    const s = await scoped.sessions.get(sessionId);
    if (!s) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);

    const terminalStatuses = ["completed", "failed", "archived", "stopped"];
    if (terminalStatuses.includes(s.status)) {
      return { ok: false, message: `session already terminal (status=${s.status})` };
    }

    // Find the executor handle and call terminate (SIGKILL-first).
    const handle = s.session_id;
    if (handle) {
      const { getExecutor } = await import("../../core/executor.js");
      const executorName = (s.config as Record<string, unknown> | null)?.launch_executor as string | undefined;
      const executor = executorName ? getExecutor(executorName) : undefined;

      if (executor) {
        if (executor.terminate) {
          await executor.terminate(handle);
        } else {
          await executor.kill(handle);
        }
      }
    }

    // Mark session failed with reason "killed".
    await scoped.sessions.update(sessionId, {
      status: "failed",
      error: "killed",
      session_id: null,
    } as Partial<import("../../types/index.js").Session>);

    await scoped.events.log(sessionId, "session_killed", {
      actor: "user",
      data: { handle: handle ?? null },
    });

    // Run D2 cleanup synchronously so the caller can rely on post-conditions.
    const updated = (await scoped.sessions.get(sessionId))!;
    if (updated) {
      const { cleanupSession } = await import("../../core/services/session/cleanup.js");
      await cleanupSession(scoped, updated);
    }

    const final = await scoped.sessions.get(sessionId);
    if (final) notify("session/updated", { session: final });

    return { ok: true, terminated_at: Date.now(), cleaned_up: true };
  });

  router.handle("session/archive", async (params, notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.archive(sessionId);
    if (result.ok) notify("session/updated", { session: await scoped.sessions.get(sessionId) });
    return result;
  });

  router.handle("session/restore", async (params, notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.restore(sessionId);
    if (result.ok) notify("session/updated", { session: await scoped.sessions.get(sessionId) });
    return result;
  });

  // ── Session attach ──────────────────────────────────────────────────────
  //
  // Domain logic lives in SessionAttachService; this handler only resolves
  // the tenant-scoped session and serialises the AttachPlan over the wire.
  // No status/runtime/compute branching here.
  router.handle("session/attach-command", async (params, _notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const session = await scoped.sessions.get(sessionId);
    if (!session) {
      throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    }
    return scoped.sessionAttach.planFor(session);
  });

  router.handle("worktree/diff", async (params, _notify, ctx) => {
    const { sessionId, base } = extract<{ sessionId: string; base?: string }>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    return scoped.sessionService.worktreeDiff(sessionId, { base });
  });

  router.handle("worktree/create-pr", async (params, notify, ctx) => {
    const { sessionId, title, body, base, draft } = extract<{
      sessionId: string;
      title?: string;
      body?: string;
      base?: string;
      draft?: boolean;
    }>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.createWorktreePR(sessionId, { title, body, base, draft });
    const session = await scoped.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("worktree/finish", async (params, _notify, ctx) => {
    const { sessionId, noMerge, createPR } = extract<WorktreeFinishParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.finishWorktree(sessionId, {
      noMerge: noMerge ?? false,
      createPR: createPR ?? false,
    });
    return result;
  });

  // ── Todos ────────────────────────────────────────────────────────────────

  router.handle("todo/list", async (params, _notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    return { todos: await scoped.todos.list(sessionId) };
  });

  router.handle("todo/add", async (params, _notify, ctx) => {
    const { sessionId, content } = extract<{ sessionId: string; content: string }>(params, ["sessionId", "content"]);
    const scoped = resolveTenantApp(app, ctx);
    return { todo: await scoped.todos.add(sessionId, content) };
  });

  router.handle("todo/toggle", async (params, _notify, ctx) => {
    const { id } = extract<{ id: number }>(params, ["id"]);
    const scoped = resolveTenantApp(app, ctx);
    const todo = await scoped.todos.toggle(id);
    return { todo };
  });

  router.handle("todo/delete", async (params, _notify, ctx) => {
    const { id } = extract<{ id: number }>(params, ["id"]);
    const scoped = resolveTenantApp(app, ctx);
    return { ok: await scoped.todos.delete(id) };
  });

  // ── Verification ─────────────────────────────────────────────────────────

  router.handle("verify/run", async (params, _notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    return scoped.sessionLifecycle.runVerification(sessionId);
  });

  // ── Export ─────────────────────────────────────────────────────────────

  router.handle("session/export", async (params, _notify, ctx) => {
    const { sessionId, filePath } = extract<{ sessionId: string; filePath?: string }>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const { exportSession, exportSessionToFile } = await import("../../core/session/share.js");
    if (filePath) {
      const ok = await exportSessionToFile(scoped, sessionId, filePath);
      return { ok, filePath };
    }
    const data = await exportSession(scoped, sessionId);
    if (!data) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    return { ok: true, data };
  });

  // ── Artifact tracking ──────────────────────────────────────────────────────

  router.handle("session/artifacts/list", async (params, _notify, ctx) => {
    const { sessionId, type } = extract<{ sessionId: string; type?: string }>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const artifacts = await scoped.artifacts.list(sessionId, type as any);
    return { artifacts };
  });

  router.handle("session/artifacts/query", async (params, _notify, ctx) => {
    const q = extract<{ session_id?: string; type?: string; value?: string; limit?: number }>(params, []);
    const scoped = resolveTenantApp(app, ctx);
    const artifacts = await scoped.artifacts.query(q as any);
    return { artifacts };
  });

  // ── Replay ──────────────────────────────────────────────────────────────────

  router.handle("session/replay", async (params, _notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const { buildReplay } = await import("../../core/session/replay.js");
    const steps = await buildReplay(scoped, sessionId);
    return { steps };
  });

  // ── Mid-session intervention (claude-agent) ─────────────────────────────
  //
  // Appends a user message to `<sessionDir>/interventions.jsonl`. A running
  // claude-agent launch.ts tails that file and pushes each line into its prompt
  // queue so the agent picks up the correction on its next turn.
  //
  // Do NOT route through deliverToChannel -- claude-agent has no channel port.
  // File-tail is the transport.

  router.handle("session/inject", async (params, _notify, ctx) => {
    const { sessionId, content } = extract<{ sessionId: string; content: string }>(params, ["sessionId", "content"]);
    const scoped = resolveTenantApp(app, ctx);

    const s = await scoped.sessions.get(sessionId);
    if (!s) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    if (s.status !== "running") {
      return { ok: false, message: `session not running (status=${s.status})` };
    }

    const sessionDir = join(scoped.config.dirs.tracks, sessionId);
    const interventionPath = join(sessionDir, "interventions.jsonl");
    const line = JSON.stringify({ role: "user", content, ts: Date.now() }) + "\n";

    // mkdirSync is not needed -- claude-agent executor always creates sessionDir at
    // dispatch time. Use promises.mkdir with recursive as a belt-and-braces guard.
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.appendFile(interventionPath, line, "utf8");

    await scoped.events.log(sessionId, "session_injected", {
      actor: "user",
      data: { content_preview: content.slice(0, 80) },
    });

    return { ok: true };
  });
}
