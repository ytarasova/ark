/**
 * SessionService -- owns session lifecycle orchestration.
 *
 * Core lifecycle methods (start, stop, resume, complete, pause, delete, undelete)
 * are fully ported. State-machine methods (applyHookStatus, applyReport) live
 * in session-orchestration.ts.
 *
 * Complex methods (dispatch, advance, fork, clone, etc.) delegate to the
 * existing session-orchestration.ts functions for now.
 */

import type { Session, SessionStatus, CreateSessionOpts, SessionOpResult } from "../../types/index.js";
import type { SessionRepository } from "../repositories/session.js";
import type { EventRepository } from "../repositories/event.js";
import type { MessageRepository } from "../repositories/message.js";
import type { AppContext } from "../app.js";
import { logDebug } from "../observability/structured-log.js";
import { SessionDispatchListeners, markDispatchFailedShared } from "./session-dispatch-listeners.js";

// ── SessionService ───────────────────────────────────────────────────────────

export class SessionService {
  /**
   * `app` is optional so a SessionService can be constructed with just repos
   * in pure-unit tests that only exercise `start()` + direct repo pass-throughs.
   * Methods that reach into other AppContext services (stop, dispatch, spawn,
   * advance, ...) throw via the `app` accessor when the service was built
   * without one.
   */
  private readonly dispatchListeners: SessionDispatchListeners;

  constructor(
    private sessions: SessionRepository,
    private events: EventRepository,
    private messages: MessageRepository,
    private readonly _app: AppContext | null = null,
  ) {
    // The default dispatcher routes through DispatchService.dispatch (typed
    // DispatchResult) rather than the SessionService.dispatch wrapper which
    // returns the looser SessionOpResult shape. The listener relies on the
    // typed `launched:boolean` discriminator.
    this.dispatchListeners = new SessionDispatchListeners(this.sessions, this.events, (sessionId) =>
      this.app.dispatchService.dispatch(sessionId),
    );
  }

  private get app(): AppContext {
    if (!this._app) {
      throw new Error("SessionService: AppContext required for this method -- pass app to the constructor");
    }
    return this._app;
  }

  // ── Core lifecycle (fully ported) ─────────────────────────────────────────

  /**
   * Create a new session with sensible defaults.
   * Port of session.ts startSession() -- simplified: no flow-stage resolution,
   * no telemetry, no OTLP spans (those belong at the orchestration layer above).
   */
  async start(opts: CreateSessionOpts): Promise<Session> {
    const session = await this.sessions.create(opts);

    // Apply agent override if specified
    if (opts.agent) {
      await this.sessions.update(session.id, { agent: opts.agent } as Partial<Session>);
    }

    // Log creation event
    await this.events.log(session.id, "session_created", {
      actor: "system",
      data: {
        flow: opts.flow ?? "default",
        repo: opts.repo ?? null,
        agent: opts.agent ?? null,
      },
    });

    return (await this.sessions.get(session.id))!;
  }

  /**
   * Stop a session. Idempotent -- already-stopped/completed/failed returns ok.
   * When a running process exists (session_id set) and orchestration is available,
   * delegates for proper tmux/provider cleanup. Otherwise does a local state transition.
   */
  async stop(id: string, opts?: { force?: boolean }): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    // Idempotent: already in terminal state with no running process
    if (!opts?.force && ["stopped", "completed", "failed"].includes(session.status) && !session.session_id) {
      return { ok: true, message: "OK", sessionId: id };
    }

    // If there's a running process and AppContext is available, delegate to
    // orchestration for full cleanup (tmux kill, provider cleanup, hooks removal)
    if (session.session_id) {
      try {
        return await this.app.sessionLifecycle.stop(id, opts);
      } catch {
        logDebug("session", "AppContext not available (e.g. unit tests) -- fall through to local stop");
      }
    }

    // Local state transition -- no process cleanup needed (or not available)
    await this.sessions.update(id, {
      status: "stopped" as SessionStatus,
      error: null,
      session_id: null,
    } as Partial<Session>);
    await this.events.log(id, "session_stopped", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { session_id: session.session_id, agent: session.agent },
    });

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Stop all running sessions. Used during test teardown and hosted shutdown.
   * Goes through the proper stop sequence for each (provider kill + cleanup).
   *
   * IMPORTANT: callers (AppContext.shutdown) must await this BEFORE closing the
   * underlying database. Previously the sync `app.sessions.list({})` call was
   * scheduled after the DB was already closed in some shutdown orderings,
   * producing the "Cannot use a closed database" stderr noise across tests.
   * Now `list({})` is a real promise that resolves against the live db, and
   * we swallow + log a warn if the db has already been closed -- shutdown is
   * best-effort.
   */
  async stopAll(): Promise<void> {
    let all: Session[] = [];
    try {
      all = await this.sessions.list({});
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // Tolerate the race where shutdown teardown raced ahead of stopAll.
      if (/closed/i.test(msg) || /database/i.test(msg)) {
        logDebug("session", `stopAll: db already closed, skipping (${msg})`);
        return;
      }
      throw err;
    }
    if (all.length === 0) return;
    for (const s of all) {
      if (s.session_id) {
        try {
          await this.app.sessionLifecycle.stop(s.id, { force: true });
        } catch (err: any) {
          logDebug("session", `stopAll: ${s.id}: ${err?.message ?? err}`);
        }
      }
    }
  }

  // ── Lifecycle-driven dispatch ─────────────────────────────────────────────
  //
  // The service owns every "a new session was created, launch it" moment.
  // Callers -- handlers, CLI, fork/clone/spawn orchestration -- just notify
  // the service that a session was created; dispatch happens automatically
  // in the background via SessionDispatchListeners (see sibling file).

  /** @see SessionDispatchListeners.subscribe */
  onSessionCreated(listener: (sessionId: string) => void): () => void {
    return this.dispatchListeners.subscribe(listener);
  }

  /** @see SessionDispatchListeners.emit */
  emitSessionCreated(sessionId: string): void {
    this.dispatchListeners.emit(sessionId);
  }

  /** @see SessionDispatchListeners.registerDefaultDispatcher */
  registerDefaultDispatcher(onDispatched: (session: Session | null) => void): () => void {
    return this.dispatchListeners.registerDefaultDispatcher(onDispatched);
  }

  /** @see SessionDispatchListeners.drain -- await in-flight dispatches at shutdown. */
  async drainPendingDispatches(): Promise<void> {
    await this.dispatchListeners.drain();
  }

  /**
   * Persist a session input blob and return an opaque locator callers should
   * store in `session.config.inputs.files[<role>]`. The locator is then fed
   * back through `input/read` (or decoded server-side) to retrieve the bytes.
   *
   * Backend selection is driven by config: local profile -> on-disk under
   * `{arkDir}/blobs/<tenantId>/inputs/<id>/<filename>`, control-plane
   * profile -> S3 under `{prefix}/<tenantId>/inputs/<id>/<filename>`.
   *
   * The return shape changed from `{ path }` to `{ locator }` on purpose --
   * the old filesystem path leaked arkDir and broke past a single replica.
   */
  async saveInput(opts: {
    name: string;
    role: string;
    content: string;
    contentEncoding?: "base64" | "utf-8";
  }): Promise<{ locator: string }> {
    const { basename } = await import("path");
    const { LOCAL_TENANT_ID } = await import("../storage/blob-store.js");
    const safeName = basename(opts.name).replace(/[^\w.\-]/g, "_");
    const safeRole = opts.role.replace(/[^\w.\-]/g, "_");
    const encoding = opts.contentEncoding ?? "utf-8";
    const bytes = encoding === "base64" ? Buffer.from(opts.content, "base64") : Buffer.from(opts.content, "utf-8");

    const tenantId = this.app.tenantId ?? LOCAL_TENANT_ID;
    const id = `${Date.now().toString(36)}-${safeRole}`;
    const meta = await this.app.blobStore.put({ tenantId, namespace: "inputs", id, filename: safeName }, bytes);
    return { locator: meta.locator };
  }

  /**
   * Resume a stopped/failed session: clear runtime state, mark ready, and
   * kick a *background* dispatch so the current stage starts running again.
   * The earlier "does NOT auto-dispatch" port left the RPC caller to kick
   * dispatch manually, but nobody did -- the Restart button in the UI just
   * flipped status back to "ready" and the session sat idle forever.
   *
   * Kicking in the background (rather than awaiting dispatch) matches the
   * `session_created` -> default-dispatcher contract: the RPC returns
   * immediately with status="ready", and the session flips to "running"
   * once the launcher lands. Tests that assert `status === "ready"`
   * straight after the RPC still pass.
   *
   * Killing any lingering executor handle first keeps a zombie tmux session
   * from holding the claude session-id across a resume.
   */
  async resume(id: string, opts?: { rewindToStage?: string }): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    // Rewind allows re-running a completed session from any stage. Without a
    // rewind, completed sessions stay blocked -- there's nothing meaningful to
    // "resume" since the flow already terminated.
    if (session.status === "completed" && !opts?.rewindToStage) {
      return {
        ok: false,
        message: "Session is already completed. Pick a stage to restart from.",
      };
    }
    if (session.status === "running" && session.session_id) {
      return { ok: false, message: "Already running" };
    }

    if (session.session_id) {
      // Best-effort kill across every registered executor -- the handle is
      // an opaque string that only the owning executor knows how to clean
      // up (tmux session name for claude-code, `sdk-<id>` for agent-sdk,
      // etc.). A missing/dead handle after a crash is expected on resume.
      const handle = session.session_id;
      for (const entry of this.app.pluginRegistry.listByKind("executor")) {
        try {
          await entry.impl.kill(handle);
        } catch (err: any) {
          // try next executor -- only the owning executor knows the handle
          logDebug("session", `kill via executor '${entry.name}' failed: ${err?.message ?? err}`);
        }
      }
    }

    // Apply rewind updates: reset stage, wipe the claude conversation id so the
    // agent starts fresh, drop pr_url (so `create_pr` doesn't skip on a rerun),
    // and clear any cached flow-graph state (completed-stage tracking) so the
    // DAG orchestrator doesn't auto-skip already-completed successors.
    const targetStage = opts?.rewindToStage ?? session.stage ?? null;
    const rewinding = !!opts?.rewindToStage && opts.rewindToStage !== session.stage;

    const updates: Partial<Session> = {
      status: "ready" as SessionStatus,
      error: null,
      breakpoint_reason: null,
      attached_by: null,
      session_id: null,
    };
    if (rewinding) {
      updates.stage = targetStage;
      updates.claude_session_id = null;
      updates.pr_url = null;
      const cfg = { ...(session.config ?? {}) } as Record<string, unknown>;
      delete cfg.last_snapshot_id;
      updates.config = cfg;

      // The DAG orchestrator persists completed-stage tracking in the
      // flow_state table. If that row survives the rewind, `getReadyStages`
      // sees every stage as already-completed and the flow stalls at a
      // phantom join-barrier -- the agent runs, finishes, and the DAG
      // refuses to advance because it thinks all successors have already
      // run. Delete the row so the rewind truly starts over.
      try {
        await this.app.flowStates.delete(id);
      } catch {
        logDebug("session", "flow-state delete is best-effort");
      }
    }
    await this.sessions.update(id, updates);

    await this.events.log(id, "session_resumed", {
      stage: targetStage ?? undefined,
      actor: "user",
      data: {
        from_status: session.status,
        ...(rewinding ? { rewound_to: targetStage, from_stage: session.stage } : {}),
      },
    });

    // Route based on the (post-rewind) stage's action type: agent stages go
    // through the usual dispatcher (tmux + claude launch). Action stages
    // (`create_pr`, `merge`, ...) are not dispatchable -- `dispatch()` returns
    // `ok:false` with "Stage 'X' is action, not agent". For those, re-run the
    // action via `executeAction`, matching the auto-handoff path at
    // `session-hooks.ts:737`. Without this branch, Restart on any session
    // whose current stage is an action is silently a no-op.
    const route = await this.resolveResumeRoute(id, session.flow, targetStage);
    if (route === "agent") {
      // Re-emit the session_created lifecycle moment so the registered
      // default dispatcher picks it up. That path owns its own pending-set
      // tracking and dispatch_failed surfacing -- no need for a private
      // kickDispatch shim on SessionService.
      this.emitSessionCreated(id);
    } else if (route === "action") {
      this.kickActionStage(id);
    }

    return { ok: true, message: "OK", sessionId: id };
  }

  /** Pick the re-run path for the session's current stage. */
  private async resolveResumeRoute(
    sessionId: string,
    flowName: string,
    stage: string | null,
  ): Promise<"agent" | "action" | "noop"> {
    if (!stage) return "noop";
    try {
      const flow = await import("./flow.js");
      const action = flow.getStageAction(this.app, flowName, stage);
      if (action.type === "agent" || action.type === "fork") return "agent";
      if (action.type === "action") return "action";
    } catch (err) {
      await this.events.log(sessionId, "dispatch_failed", {
        actor: "system",
        data: { reason: `resolveResumeRoute failed: ${err instanceof Error ? err.message : String(err)}` },
      });
    }
    return "noop";
  }

  /**
   * Re-run a non-agent action stage in the background. Mirrors the handoff
   * path in `session-hooks.ts` but without the auto-advance chaining -- the
   * user explicitly asked to re-run THIS stage; if the action succeeds the
   * normal post-action handoff takes over from there.
   */
  private kickActionStage(sessionId: string): void {
    const promise = (async () => {
      try {
        const session = await this.sessions.get(sessionId);
        if (!session?.stage) return;
        const flow = await import("./flow.js");
        const action = flow.getStageAction(this.app, session.flow, session.stage);
        if (action.type !== "action" || !action.action) return;
        const { executeAction } = await import("./actions/index.js");
        const result = await executeAction(this.app, sessionId, action.action);
        if (!result.ok) {
          // Without flipping status to `failed`, an action stage that errors
          // on resume (`create_pr`, `merge`, ...) emits the dispatch_failed
          // event but the session row stays at `status=ready` forever. Use
          // the shared helper so resume + auto-handoff produce the same
          // event + status-update shape on action failure.
          await markDispatchFailedShared(
            this.sessions,
            this.events,
            sessionId,
            `action '${action.action}' failed: ${result.message}`,
          );
          return;
        }
        // Success: advance the flow. Without this, an action stage
        // re-run via resume (e.g. a create_pr that failed once and got
        // retried) completes the action but leaves the session sitting
        // at `status=ready, stage=<action>` forever. The regular
        // dispatch path handles this via `mediateStageHandoff` after
        // `executeAction` returns (see dispatch-core.ts); mirror that
        // here so resume behaves the same way.
        const postAction = await this.sessions.get(sessionId);
        if (postAction?.status === "ready") {
          await this.app.sessionHooks.mediateStageHandoff(sessionId, {
            autoDispatch: true,
            source: "resume_action",
          });
        }
      } catch (err) {
        // Mirror the action-failure branch above: thrown errors leave the
        // session at status=ready otherwise. markDispatchFailedShared logs
        // the dispatch_failed event AND flips status to failed.
        await markDispatchFailedShared(
          this.sessions,
          this.events,
          sessionId,
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
    // Register on the listener's pending set so app.shutdown() awaits this
    // background promise alongside listener-owned dispatches.
    this.dispatchListeners.track(promise);
  }

  /**
   * Mark session as completed.
   * Port of session.ts complete() -- simplified: just marks ready + logs event.
   * The advance() call is the caller's responsibility.
   */
  async complete(id: string): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    await this.events.log(id, "stage_completed", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { note: "Manually completed" },
    });

    await this.messages.markRead(id);
    await this.sessions.update(id, { status: "ready" as SessionStatus, session_id: null } as Partial<Session>);

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Pause a session (set to blocked).
   * Port of session.ts pause().
   */
  async pause(id: string, reason?: string): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    await this.sessions.update(id, {
      status: "blocked" as SessionStatus,
      breakpoint_reason: reason ?? "User paused",
    } as Partial<Session>);

    await this.events.log(id, "session_paused", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { reason, was_status: session.status },
    });

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Interrupt a running agent (Ctrl+C) without killing the tmux session.
   * Delegates to session-orchestration.ts interrupt().
   */
  async interrupt(id: string): Promise<SessionOpResult> {
    return this.app.sessionLifecycle.interrupt(id);
  }

  /**
   * Archive a session for later reference.
   */
  async archive(id: string): Promise<SessionOpResult> {
    return this.app.sessionLifecycle.archive(id);
  }

  /**
   * Restore an archived session back to stopped.
   */
  async restore(id: string): Promise<SessionOpResult> {
    return this.app.sessionLifecycle.restore(id);
  }

  /**
   * Soft-delete a session (90s undo window).
   * Port of session.ts deleteSessionAsync() -- simplified: no tmux/provider
   * cleanup (caller handles), just state transition.
   */
  async delete(id: string): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    await this.sessions.softDelete(id);

    await this.events.log(id, "session_deleted", { actor: "user" });

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Restore a soft-deleted session.
   * Port of session.ts undeleteSessionAsync().
   */
  async undelete(id: string): Promise<SessionOpResult> {
    const restored = await this.sessions.undelete(id);
    if (!restored) return { ok: false, message: `Session ${id} not found or not deleted` };

    await this.events.log(id, "session_undeleted", { actor: "user" });

    return { ok: true, message: "OK", sessionId: id };
  }

  // ── Delegating methods (complex orchestration -- call through to session.ts) ──

  /**
   * Dispatch a session: resolve agent, build task, launch executor.
   * Delegates to the DispatchService which owns tmux/executor/flow logic.
   */
  async dispatch(id: string, opts?: { onLog?: (msg: string) => void }): Promise<SessionOpResult> {
    return this.app.dispatchService.dispatch(id, opts);
  }

  /**
   * Advance a session to the next flow stage.
   * Delegates to the StageAdvanceService which owns gate evaluation and flow progression.
   */
  async advance(id: string, force?: boolean): Promise<SessionOpResult> {
    return this.app.stageAdvance.advance(id, force);
  }

  /**
   * Get captured output from a running session's tmux pane.
   */
  async getOutput(id: string, opts?: { lines?: number; ansi?: boolean }): Promise<string> {
    const { getOutput: legacyGetOutput } = await import("./session-output.js");
    return legacyGetOutput(this.app, id, opts);
  }

  /**
   * Send a message to a running session's tmux pane.
   */
  async send(id: string, message: string): Promise<SessionOpResult> {
    const { send: legacySend } = await import("./session-output.js");
    return legacySend(this.app, id, message);
  }

  /**
   * Poll until session reaches a terminal state (completed/failed/stopped).
   */
  async waitForCompletion(
    id: string,
    opts?: { timeoutMs?: number; pollMs?: number; onStatus?: (status: string) => void },
  ): Promise<{ session: Session | null; timedOut: boolean }> {
    return this.app.sessionLifecycle.waitForCompletion(id, opts);
  }

  /**
   * Fork a session: create a new session from the same point in the flow.
   */
  async fork(id: string, name?: string): Promise<SessionOpResult> {
    // session.ts has a narrower local SessionOpResult (no `message` on success)
    return this.app.sessionLifecycle.fork(id, name, {
      onCreated: (sid) => this.emitSessionCreated(sid),
    }) as unknown as SessionOpResult;
  }

  /**
   * Clone a session: deep copy including claude_session_id for --resume.
   */
  async clone(id: string, name?: string): Promise<SessionOpResult> {
    return this.app.sessionLifecycle.clone(id, name, {
      onCreated: (sid) => this.emitSessionCreated(sid),
    }) as unknown as SessionOpResult;
  }

  /**
   * Spawn a subagent session under a parent.
   */
  async spawn(
    parentId: string,
    opts: {
      task: string;
      agent?: string;
      group_name?: string;
      extensions?: string[];
    },
  ): Promise<SessionOpResult> {
    const { spawnSubagent } = await import("./subagents.js");
    return spawnSubagent(this.app, parentId, opts);
  }

  /**
   * Fan-out: create parallel child sessions from a parent.
   */
  async fanOut(sessionId: string, opts: { tasks: Array<{ summary: string; agent?: string; flow?: string }> }) {
    const { fanOut } = await import("./fork-join.js");
    return fanOut(this.app, sessionId, opts);
  }

  /**
   * Handoff: clone session to a different agent and dispatch.
   */
  async handoff(id: string, agent: string, instructions?: string): Promise<SessionOpResult> {
    return this.app.stageAdvance.handoff(id, agent, instructions);
  }

  /**
   * Get a diff summary for a session's worktree branch vs its base branch.
   */
  async worktreeDiff(id: string, opts?: { base?: string }): Promise<any> {
    const { worktreeDiff: legacyDiff } = await import("./worktree/index.js");
    return legacyDiff(this.app, id, opts);
  }

  /**
   * Finish a worktree: merge back and clean up.
   */
  async finishWorktree(
    id: string,
    opts?: {
      into?: string;
      noMerge?: boolean;
      keepBranch?: boolean;
      createPR?: boolean;
    },
  ): Promise<SessionOpResult> {
    const { finishWorktree: legacyFinish } = await import("./worktree/index.js");
    return legacyFinish(this.app, id, opts);
  }

  /**
   * Rebase a session's branch onto the base branch.
   */
  async rebaseOntoBase(id: string, opts?: { base?: string }): Promise<SessionOpResult> {
    const { rebaseOntoBase: legacyRebase } = await import("./worktree/index.js");
    return legacyRebase(this.app, id, opts);
  }

  /**
   * Create a GitHub PR from a session's worktree branch.
   */
  async createWorktreePR(
    id: string,
    opts?: { title?: string; body?: string; base?: string; draft?: boolean },
  ): Promise<SessionOpResult & { pr_url?: string }> {
    const { createWorktreePR: legacyCreatePR } = await import("./worktree/index.js");
    return legacyCreatePR(this.app, id, opts);
  }

  /**
   * Join forked children back into parent session.
   */
  async join(parentId: string, force?: boolean): Promise<SessionOpResult> {
    const { joinFork } = await import("./fork-join.js");
    return joinFork(this.app, parentId, force);
  }

  /**
   * Approve a review gate and force-advance past it.
   */
  async approveReviewGate(id: string): Promise<SessionOpResult> {
    const { approveReviewGate: legacyApprove } = await import("./review-gate.js");
    return legacyApprove(this.app, id);
  }

  /**
   * Reject a review gate and dispatch a rework cycle. Renders `on_reject.prompt`
   * (with `{{rejection_reason}}` substituted) and appends it to the next
   * dispatch of the current stage. When `on_reject.max_rejections` is
   * exceeded, the session is marked failed instead.
   */
  async rejectReviewGate(id: string, reason: string): Promise<SessionOpResult> {
    const { rejectReviewGate: legacyReject } = await import("./review-gate.js");
    const r = await legacyReject(this.app, id, reason ?? "");
    // review-gate returns { ok, message } without sessionId; widen to SessionOpResult.
    return { ...r, sessionId: id } as SessionOpResult;
  }

  // ── Query helpers ─────────────────────────────────────────────────────────

  get(id: string): Promise<Session | null> {
    return this.sessions.get(id);
  }

  list(filters?: Parameters<SessionRepository["list"]>[0]): Promise<Session[]> {
    return this.sessions.list(filters);
  }
}
