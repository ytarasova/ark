import { promises as fsPromises } from "fs";
import { join } from "path";
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
    // `start()` emits `session_created` before returning; the default
    // dispatcher listener (registered above) kicks the background launcher.
    const session = await app.sessionLifecycle.start(opts, {
      onCreated: (id) => app.sessionService.emitSessionCreated(id),
    });
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
    const session = await app.sessions.get(sessionId);
    if (session) notify("session/updated", { session });
    return result;
  });

  router.handle("session/advance", async (params, notify) => {
    const { sessionId, force } = extract<SessionAdvanceParams>(params, ["sessionId"]);
    const sessForLog = await app.sessions.get(sessionId);
    await app.events.log(sessionId, "stage_advanced", {
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
    const session = await app.sessions.get(sessionId);
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
      await app.sessions.update(result.sessionId, { group_name });
    }
    const session = result.sessionId ? await app.sessions.get(result.sessionId) : null;
    if (session) notify("session/created", { session });
    return { session };
  });

  router.handle("session/clone", async (params, notify) => {
    const { sessionId, name } = extract<SessionCloneParams>(params, ["sessionId"]);
    const result = await app.sessionService.clone(sessionId, name);
    if (!result.ok) {
      throw new RpcError(result.message, SESSION_NOT_FOUND);
    }
    const session = result.sessionId ? await app.sessions.get(result.sessionId) : null;
    if (session) notify("session/created", { session });
    return { session };
  });

  router.handle("session/update", async (params, notify) => {
    const { sessionId, fields } = extract<SessionUpdateParams>(params, ["sessionId", "fields"]);
    const existing = await app.sessions.get(sessionId);
    if (!existing) {
      throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    }
    await app.sessions.update(sessionId, fields);
    const session = await app.sessions.get(sessionId);
    notify("session/updated", { session });
    return { session };
  });

  router.handle("session/list", async (params, _notify) => {
    const filters = extract<SessionListParams>(params, []);
    // rootsOnly switches to the tree-aware path so every row carries a
    // `child_stats` rollup. Flat behaviour is preserved when unset/false.
    if (filters?.rootsOnly) {
      const sessions = await app.sessions.listRoots(filters);
      return { sessions };
    }
    const sessions = await app.sessions.list(filters);
    return { sessions };
  });

  router.handle("session/list_children", async (params, _notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const sessions = await app.sessions.listChildren(sessionId);
    return { sessions };
  });

  router.handle("session/tree", async (params, _notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const existing = await app.sessions.get(sessionId);
    if (!existing) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    try {
      const root = await app.sessions.loadTree(sessionId);
      return { root };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // Bubble the parent-required error as a clean RpcError so the UI can
      // show an actionable message without relying on string matching.
      throw new RpcError(msg, SESSION_NOT_FOUND);
    }
  });

  router.handle("session/read", async (params, _notify) => {
    const { sessionId, include } = extract<SessionReadParams>(params, ["sessionId"]);
    const session = await app.sessions.get(sessionId);
    if (!session) {
      throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    }
    const result: Record<string, unknown> = { session };
    if (include?.includes("events")) {
      result.events = await app.events.list(sessionId);
    }
    if (include?.includes("messages")) {
      result.messages = await app.messages.list(sessionId);
    }
    return result;
  });

  // ── Queries ────────────────────────────────────────────────────────────────

  router.handle("session/events", async (params, _notify) => {
    const { sessionId, limit } = extract<SessionEventsParams>(params, ["sessionId"]);
    const events = await app.events.list(sessionId, { limit });
    return { events };
  });

  router.handle("session/messages", async (params, _notify) => {
    const { sessionId, limit } = extract<SessionMessagesParams>(params, ["sessionId"]);
    const messages = await app.messages.list(sessionId, { limit });
    return { messages };
  });

  router.handle("session/search", async (params, _notify) => {
    const { query } = extract<SessionSearchParams>(params, ["query"]);
    const results = await searchSessions(app, query);
    return { results };
  });

  router.handle("session/conversation", async (params, _notify) => {
    const { sessionId, limit } = extract<{ sessionId: string; limit?: number }>(params, ["sessionId"]);
    const turns = await getSessionConversation(app, sessionId, { limit });
    return { turns };
  });

  router.handle("session/search-conversation", async (params, _notify) => {
    const { sessionId, query } = extract<{ sessionId: string; query: string }>(params, ["sessionId", "query"]);
    const results = await searchSessionConversation(app, sessionId, query);
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
    const session = await app.sessions.get(sessionId);
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
      const session = await app.sessions.get(result.sessionId);
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
      const session = await app.sessions.get(childId);
      if (session) notify("session/created", { session });
    }
    // Fan-out children are dispatched en masse by the orchestrator (see
    // stage-orchestrator.ts:1252). No need to loop here.
    return result;
  });

  router.handle("session/resume", async (params, notify) => {
    const { sessionId, snapshotId, rewindToStage } = extract<SessionResumeParams>(params, ["sessionId"]);

    // Snapshot-backed restore bypasses rewind: restoring a pinned snapshot is
    // a different operation from "re-run from stage X". If the caller wants
    // a rewind, they must not also ask for a snapshot.
    const session = await app.sessions.get(sessionId);
    const lastSnapshotId =
      snapshotId ?? (session?.config as Record<string, unknown> | undefined)?.last_snapshot_id ?? undefined;

    if (lastSnapshotId && !rewindToStage) {
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

    const result = await app.sessionService.resume(sessionId, { rewindToStage });
    const updated = await app.sessions.get(sessionId);
    if (updated) notify("session/updated", { session: updated });
    return result;
  });

  router.handle("session/flowStages", async (params) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const session = await app.sessions.get(sessionId);
    if (!session) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    const { getStages } = await import("../../core/state/flow.js");
    const stages = getStages(app, session.flow).map((s) => ({
      name: s.name,
      type: s.action ? "action" : s.agent ? "agent" : (s.type ?? "agent"),
      agent: s.agent ?? null,
      action: s.action ?? null,
    }));
    return { flow: session.flow, currentStage: session.stage, stages };
  });

  router.handle("session/pause", async (params, notify) => {
    const { sessionId, reason } = extract<SessionPauseParams>(params, ["sessionId"]);

    // Try the snapshot-backed pause first. If the underlying compute doesn't
    // support snapshot we transparently fall back to a state-only pause so
    // local sessions keep working the way they did before snapshotting.
    const { pauseWithSnapshot } = await import("../../core/services/session-snapshot.js");
    const snapResult = await pauseWithSnapshot(app, sessionId, { reason });
    const session = await app.sessions.get(sessionId);

    if (snapResult.ok) {
      if (session) notify("session/updated", { session });
      return { ok: true, message: snapResult.message, snapshot: snapResult.snapshot };
    }
    if (!snapResult.notSupported) {
      // Snapshot path failed for reasons other than capability -- surface.
      throw new RpcError(snapResult.message, SESSION_NOT_FOUND);
    }

    // Fallback: state-only pause (pre-Phase-3 behaviour).
    const result = await app.sessionService.pause(sessionId, reason);
    const updated = await app.sessions.get(sessionId);
    if (updated) notify("session/updated", { session: updated });
    return { ...result, snapshot: null, notSupported: true };
  });

  router.handle("session/interrupt", async (params) => {
    const { sessionId, content } = extract<{ sessionId: string; content: string }>(params, ["sessionId", "content"]);

    const s = await app.sessions.get(sessionId);
    if (!s) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    if (s.status !== "running") {
      return { ok: false, message: `session not running (status=${s.status})` };
    }

    // Agent-sdk sessions use file-tail IPC via interventions.jsonl.
    // Writing control:"interrupt" causes launch.ts to abort the current turn
    // and resume with options.resume = <sdkSessionId>. The content is pushed
    // into the prompt queue as the correction message for the next turn.
    const executorName = (s.config as Record<string, unknown> | null)?.launch_executor as string | undefined;
    if (executorName === "agent-sdk") {
      const sessionDir = join(app.config.tracksDir, sessionId);
      const interventionPath = join(sessionDir, "interventions.jsonl");
      await fsPromises.mkdir(sessionDir, { recursive: true });
      const line = JSON.stringify({ role: "user", content, control: "interrupt", ts: Date.now() }) + "\n";
      await fsPromises.appendFile(interventionPath, line, "utf8");

      await app.events.log(sessionId, "session_interrupted", {
        actor: "user",
        data: { content_preview: content.slice(0, 80) },
      });

      return { ok: true };
    }

    // Non-agent-sdk sessions: fall back to the tmux C-c interrupt.
    const result = await app.sessionLifecycle.interrupt(sessionId);
    return result;
  });

  // ── session/kill -- hard terminate, no grace ──────────────────────────────
  //
  // Goes straight to SIGKILL (skips the SIGTERM grace that session/stop uses).
  // Marks session `failed` with reason `killed` and runs D2 cleanup
  // synchronously so post-conditions are reliable for the caller.

  router.handle("session/kill", async (params, notify) => {
    const { sessionId } = extract<{ sessionId: string }>(params, ["sessionId"]);

    const s = await app.sessions.get(sessionId);
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
    await app.sessions.update(sessionId, {
      status: "failed",
      error: "killed",
      session_id: null,
    } as Partial<import("../../types/index.js").Session>);

    await app.events.log(sessionId, "session_killed", {
      actor: "user",
      data: { handle: handle ?? null },
    });

    // Run D2 cleanup synchronously so the caller can rely on post-conditions.
    const updated = (await app.sessions.get(sessionId))!;
    if (updated) {
      const { cleanupSession } = await import("../../core/services/session/cleanup.js");
      await cleanupSession(app, updated);
    }

    const final = await app.sessions.get(sessionId);
    if (final) notify("session/updated", { session: final });

    return { ok: true, terminated_at: Date.now(), cleaned_up: true };
  });

  router.handle("session/archive", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const result = await app.sessionService.archive(sessionId);
    if (result.ok) notify("session/updated", { session: await app.sessions.get(sessionId) });
    return result;
  });

  router.handle("session/restore", async (params, notify) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const result = await app.sessionService.restore(sessionId);
    if (result.ok) notify("session/updated", { session: await app.sessions.get(sessionId) });
    return result;
  });

  // ── Session attach (CLI command string) ──────────────────────────────────
  //
  // Returns the shell command a user should run to attach to the tmux pane
  // for `sessionId`, plus a short display hint for the UI. Sessions that
  // aren't currently dispatched (no tmux pane, terminal states, missing)
  // come back as `attachable: false` with a `reason` the UI shows instead.
  //
  // For remote compute targets (ec2, k8s, ...), we delegate to the provider's
  // `getAttachCommand(compute, session)` so the returned string includes the
  // SSH / kubectl prefix the user needs to run locally.
  router.handle("session/attach-command", async (params) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const session = await app.sessions.get(sessionId);
    if (!session) {
      throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    }

    // Sessions without a dispatched tmux pane have nothing to attach to.
    if (!session.session_id) {
      return {
        command: "",
        displayHint: "",
        attachable: false,
        reason: "Session has not been dispatched yet.",
      };
    }
    if (session.status === "completed" || session.status === "failed" || session.status === "archived") {
      return {
        command: "",
        displayHint: "",
        attachable: false,
        reason: `Session is ${session.status}; no live pane to attach to.`,
      };
    }

    // Provider-aware path: ask the compute's provider for the attach command.
    // Local sessions (no compute_name) or providers that don't override get
    // the plain `tmux attach -t <name>`.
    let command = "";
    let displayHint = "Paste this into a terminal on the host running ark:";
    if (session.compute_name) {
      const compute = await app.computes.get(session.compute_name);
      if (compute) {
        const provider = app.getProvider(compute.provider);
        try {
          const parts = provider?.getAttachCommand?.(compute, session) ?? [];
          if (parts.length > 0) {
            command = parts.join(" ");
            displayHint = "Paste this into a terminal to attach to the remote compute:";
          }
        } catch {
          /* fall through to the local fallback */
        }
      }
    }
    if (!command) {
      const { attachCommand } = await import("../../core/infra/tmux.js");
      command = attachCommand(session.session_id);
    }
    return { command, displayHint, attachable: true };
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
    const session = await app.sessions.get(sessionId);
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
    return { todos: await app.todos.list(sessionId) };
  });

  router.handle("todo/add", async (params) => {
    const { sessionId, content } = extract<{ sessionId: string; content: string }>(params, ["sessionId", "content"]);
    return { todo: await app.todos.add(sessionId, content) };
  });

  router.handle("todo/toggle", async (params) => {
    const { id } = extract<{ id: number }>(params, ["id"]);
    const todo = await app.todos.toggle(id);
    return { todo };
  });

  router.handle("todo/delete", async (params) => {
    const { id } = extract<{ id: number }>(params, ["id"]);
    return { ok: await app.todos.delete(id) };
  });

  // ── Verification ─────────────────────────────────────────────────────────

  router.handle("verify/run", async (params) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    return app.sessionLifecycle.runVerification(sessionId);
  });

  // ── Export ─────────────────────────────────────────────────────────────

  router.handle("session/export", async (params) => {
    const { sessionId, filePath } = extract<{ sessionId: string; filePath?: string }>(params, ["sessionId"]);
    const { exportSession, exportSessionToFile } = await import("../../core/session/share.js");
    if (filePath) {
      const ok = await exportSessionToFile(app, sessionId, filePath);
      return { ok, filePath };
    }
    const data = await exportSession(app, sessionId);
    if (!data) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    return { ok: true, data };
  });

  // ── Artifact tracking ──────────────────────────────────────────────────────

  router.handle("session/artifacts/list", async (params) => {
    const { sessionId, type } = extract<{ sessionId: string; type?: string }>(params, ["sessionId"]);
    const artifacts = await app.artifacts.list(sessionId, type as any);
    return { artifacts };
  });

  router.handle("session/artifacts/query", async (params) => {
    const q = extract<{ session_id?: string; type?: string; value?: string; limit?: number }>(params, []);
    const artifacts = await app.artifacts.query(q as any);
    return { artifacts };
  });

  // ── Replay ──────────────────────────────────────────────────────────────────

  router.handle("session/replay", async (params) => {
    const { sessionId } = extract<SessionIdParams>(params, ["sessionId"]);
    const { buildReplay } = await import("../../core/session/replay.js");
    const steps = await buildReplay(app, sessionId);
    return { steps };
  });

  // ── Mid-session intervention (agent-sdk) ─────────────────────────────────
  //
  // Appends a user message to `<sessionDir>/interventions.jsonl`. A running
  // agent-sdk launch.ts tails that file and pushes each line into its prompt
  // queue so the agent picks up the correction on its next turn.
  //
  // Do NOT route through deliverToChannel -- agent-sdk has no channel port.
  // File-tail is the transport.

  router.handle("session/inject", async (params) => {
    const { sessionId, content } = extract<{ sessionId: string; content: string }>(params, ["sessionId", "content"]);

    const s = await app.sessions.get(sessionId);
    if (!s) throw new RpcError(`Session ${sessionId} not found`, SESSION_NOT_FOUND);
    if (s.status !== "running") {
      return { ok: false, message: `session not running (status=${s.status})` };
    }

    const sessionDir = join(app.config.tracksDir, sessionId);
    const interventionPath = join(sessionDir, "interventions.jsonl");
    const line = JSON.stringify({ role: "user", content, ts: Date.now() }) + "\n";

    // mkdirSync is not needed -- agent-sdk executor always creates sessionDir at
    // dispatch time. Use promises.mkdir with recursive as a belt-and-braces guard.
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.appendFile(interventionPath, line, "utf8");

    await app.events.log(sessionId, "session_injected", {
      actor: "user",
      data: { content_preview: content.slice(0, 80) },
    });

    return { ok: true };
  });
}
