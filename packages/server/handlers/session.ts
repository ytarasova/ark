import { promises as fsPromises, watch as fsWatch } from "fs";
import { join } from "path";
import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { resolveTenantApp } from "./scope-helpers.js";
import { eventBus } from "../../core/hooks.js";
import type {
  SessionIdParams,
  SessionStartParams,
  SessionAdvanceParams,
  SessionReadParams,
  SessionUpdateParams,
  SessionEventsParams,
  SessionMessagesParams,
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
    const { getStages } = await import("../../core/services/flow.js");
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

  // ── session/tree-stream -- subscription-style tree update push ────────────
  //
  // Subscribes the caller's connection to live debounced tree snapshots for a
  // root session. Returns an initial snapshot immediately, then pushes
  // `session/tree-update` notifications via JSON-RPC notify whenever any
  // descendant changes status or a new descendant is created.
  //
  // Uses the per-connection `Subscription` (Option A) to register cleanup so
  // event-bus listeners and debounce timers are torn down when the WS closes.
  //
  // Mirrors the SSE handler in
  // `packages/core/conductor/server/rest-api-handler.ts:handleTreeStream`.

  router.handle("session/tree-stream", async (params, notify, ctx, subscription) => {
    const { sessionId } = extract<{ sessionId: string }>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);

    const existing = await scoped.sessions.get(sessionId);
    if (!existing) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);

    const DEBOUNCE_MS = 200;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    // descendantIds is rebuilt on every snapshot so the set stays current
    // as the tree grows. Shared by the bus listener and pushSnapshot.
    let descendantIds = new Set<string>();

    const buildDescendantIds = (node: { id: string; children?: unknown[] }): void => {
      descendantIds.add(node.id);
      for (const child of node.children ?? []) {
        buildDescendantIds(child as { id: string; children?: unknown[] });
      }
    };

    const pushSnapshot = async (): Promise<void> => {
      if (closed) return;
      try {
        const root = await scoped.sessions.loadTree(sessionId);
        // Rebuild descendant set so the bus listener stays accurate.
        descendantIds = new Set<string>();
        buildDescendantIds(root as { id: string; children?: unknown[] });
        notify("session/tree-update", { sessionId, root });
      } catch (e: any) {
        notify("session/tree-error", { sessionId, error: String(e?.message ?? e) });
      }
    };

    const scheduleSnapshot = (): void => {
      if (closed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void pushSnapshot();
      }, DEBOUNCE_MS);
    };

    // Initial snapshot (also populates descendantIds).
    const initialRoot = await scoped.sessions.loadTree(sessionId);
    buildDescendantIds(initialRoot as { id: string; children?: unknown[] });

    // Subscribe to the global event bus. Filter to relevant event types and
    // tree members, mirroring the logic in the SSE handleTreeStream handler.
    const unsub = eventBus.onAll((evt) => {
      if (closed) return;
      if (evt.type !== "hook_status" && evt.type !== "session_updated" && evt.type !== "session_created") return;
      // session_created always triggers a snapshot -- the new session may be
      // a descendant whose parent is already in the tree.
      if (evt.type === "session_created") {
        scheduleSnapshot();
        return;
      }
      if (descendantIds.has(evt.sessionId)) {
        scheduleSnapshot();
      }
    });

    // Register cleanup for when the connection closes.
    subscription?.onClose(() => {
      closed = true;
      unsub();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    });

    return { tree: initialRoot };
  });

  // ── log/subscribe -- tail a forensic log file with live push ──────────────
  //
  // Returns the current file contents as `initial` (empty string when file
  // doesn't exist yet). Subsequent appends arrive as `log/chunk` notifications
  // with base64-encoded bytes.
  //
  // Implementation: `fs.watch` on the file (or its parent directory when the
  // file doesn't exist yet). On each "change" event we read from the last known
  // byte offset to end-of-file and push the diff as a base64 chunk.
  //
  // Cleanup via `subscription.onClose()` so the watcher is torn down when the
  // WS connection closes.

  router.handle("log/subscribe", async (params, notify, ctx, subscription) => {
    const { sessionId, file } = extract<{ sessionId: string; file: "stdio" | "transcript" }>(params, [
      "sessionId",
      "file",
    ]);
    if (file !== "stdio" && file !== "transcript") {
      throw new RpcError(`file must be "stdio" or "transcript", got "${file}"`, ErrorCodes.INVALID_PARAMS);
    }
    const scoped = resolveTenantApp(app, ctx);
    const session = await scoped.sessions.get(sessionId);
    if (!session) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);

    const fileName = file === "stdio" ? "stdio.log" : "transcript.jsonl";
    const filePath = join(scoped.config.dirs.tracks, sessionId, fileName);

    // Read current contents up to the 2MB cap.
    const { readForensicFile } = await import("../../core/services/session-forensic.js");
    const initial = await readForensicFile(scoped.config.dirs.tracks, sessionId, fileName);

    // Track the byte offset after the initial read so we only push new bytes.
    let offset = initial.exists ? initial.size : 0;
    let watcherClosed = false;

    // Callback: read from `offset` to EOF, push any new bytes as a base64 chunk.
    const pushNewBytes = async (): Promise<void> => {
      if (watcherClosed) return;
      let stat: { size: number };
      try {
        stat = await fsPromises.stat(filePath);
      } catch {
        return; // file disappeared -- ignore
      }
      if (stat.size <= offset) return; // no new data
      const len = stat.size - offset;
      const buf = Buffer.alloc(len);
      let fh: import("fs").promises.FileHandle | null = null;
      try {
        fh = await fsPromises.open(filePath, "r");
        await fh.read(buf, 0, len, offset);
        offset = stat.size;
        notify("log/chunk", {
          sessionId,
          file,
          bytes: buf.toString("base64"),
        });
      } catch {
        // Ignore transient read errors (file being rotated, etc.)
      } finally {
        await fh?.close().catch(() => {});
      }
    };

    // Use fs.watch on the file path. When the file doesn't exist yet, watch
    // the parent directory and filter to the target filename.
    let watcher: ReturnType<typeof fsWatch> | null = null;
    try {
      // Ensure the session directory exists so we can watch it even when the
      // file hasn't been written yet.
      const sessionDir = join(scoped.config.dirs.tracks, sessionId);
      await fsPromises.mkdir(sessionDir, { recursive: true });

      // Watch the file directly if it exists, otherwise watch the parent dir.
      const watchTarget = initial.exists ? filePath : join(scoped.config.dirs.tracks, sessionId);
      watcher = fsWatch(watchTarget, { persistent: false }, (event, watchedName) => {
        if (watcherClosed) return;
        // When watching a directory, filter to our target filename.
        if (watchedName && watchedName !== fileName && watchedName !== null) return;
        void pushNewBytes();
      });
      watcher.on("error", () => {
        // Watcher errors (ENOENT on deletion, EMFILE, etc.) are non-fatal.
      });
    } catch {
      // fs.watch may fail on some platforms (e.g., no inotify slots). We still
      // return the initial content -- new bytes just won't be pushed.
    }

    subscription?.onClose(() => {
      watcherClosed = true;
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
    });

    return {
      initial: initial.content,
      size: initial.size,
      exists: initial.exists,
    };
  });
}
