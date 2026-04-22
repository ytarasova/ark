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
import { logDebug, logWarn } from "../observability/structured-log.js";

// ── SessionService ───────────────────────────────────────────────────────────

export class SessionService {
  private _app: AppContext | null = null;

  constructor(
    private sessions: SessionRepository,
    private events: EventRepository,
    private messages: MessageRepository,
    app?: AppContext,
  ) {
    if (app) this._app = app;
  }

  /**
   * Inject AppContext after construction.
   * Prefer passing `app` via the constructor. This setter exists for cases
   * where the AppContext is not yet available at construction time (legacy).
   */
  setApp(app: AppContext): void {
    this._app = app;
  }

  /** Get the injected AppContext. Throws if not set. */
  private get app(): AppContext {
    if (!this._app) throw new Error("SessionService: AppContext not set -- pass app to constructor or call setApp()");
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
        const { stop: orchStop } = await import("./session-lifecycle.js");
        return orchStop(this.app, id, opts);
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
    const { stop: orchStop } = await import("./session-lifecycle.js");
    for (const s of all) {
      if (s.session_id) {
        try {
          await orchStop(this.app, s.id, { force: true });
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
  // in the background. The service tracks in-flight promises so `stopAll()`
  // / shutdown can drain them before teardown, otherwise tmux panes +
  // agent CLIs leak when a test or server restart interrupts a dispatch.

  private _pendingDispatches = new Set<Promise<unknown>>();
  private _sessionCreatedListeners: Array<(sessionId: string) => void> = [];

  /**
   * Subscribe to the `session_created` lifecycle moment. The default
   * subscriber kicks a background dispatch; external consumers (conductor,
   * audit sinks, etc.) can register their own.
   */
  onSessionCreated(listener: (sessionId: string) => void): () => void {
    this._sessionCreatedListeners.push(listener);
    return () => {
      const i = this._sessionCreatedListeners.indexOf(listener);
      if (i >= 0) this._sessionCreatedListeners.splice(i, 1);
    };
  }

  /**
   * Emit the `session_created` lifecycle moment. Orchestration code
   * (startSession, fork, clone, spawn) calls this after a session row has
   * been committed. All registered listeners fire synchronously; the
   * default listener kicks `dispatch` in the background.
   */
  emitSessionCreated(sessionId: string): void {
    for (const l of this._sessionCreatedListeners) {
      try {
        l(sessionId);
      } catch (err) {
        // Fire-and-forget: listener errors should not block dispatch.
        void this.events.log(sessionId, "session_created_listener_error", {
          actor: "system",
          data: { reason: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  private _defaultDispatcherUnregister: (() => void) | null = null;

  /**
   * Register the default `session_created` -> background dispatch listener.
   * Safe to call multiple times (e.g. per-test `beforeEach`): replaces any
   * previous default registration, so listeners don't accumulate and fan out
   * into duplicate dispatches.
   */
  registerDefaultDispatcher(onDispatched: (session: Session | null) => void): () => void {
    if (this._defaultDispatcherUnregister) {
      this._defaultDispatcherUnregister();
      this._defaultDispatcherUnregister = null;
    }
    const unregister = this.onSessionCreated((sessionId) => this.kickDispatch(sessionId, onDispatched));
    this._defaultDispatcherUnregister = () => {
      unregister();
      this._defaultDispatcherUnregister = null;
    };
    return this._defaultDispatcherUnregister;
  }

  private kickDispatch(sessionId: string, onDispatched: (session: Session | null) => void): void {
    const promise = this.dispatch(sessionId)
      .then(async (result) => {
        // dispatch returns `{ ok: false, message }` for non-throw failures
        // (e.g. "Stage 'pr' is create_pr, not agent" on an action stage).
        // Without this log, kickDispatch silently swallows the failure and
        // the session sits idle -- which is what broke the Restart button
        // on completed sessions whose terminal stage is an action.
        if (result && result.ok === false) {
          await this.events.log(sessionId, "dispatch_failed", {
            actor: "system",
            data: { reason: result.message ?? "dispatch returned ok: false" },
          });
        }
      })
      .catch(async (err) => {
        await this.events.log(sessionId, "dispatch_failed", {
          actor: "system",
          data: { reason: err instanceof Error ? err.message : String(err) },
        });
      })
      .then(async () => {
        onDispatched(await this.sessions.get(sessionId));
      });
    this._pendingDispatches.add(promise);
    promise
      .finally(() => this._pendingDispatches.delete(promise))
      .catch((err) => {
        logWarn("session", `SessionService: background dispatch chain threw (sessionId=${sessionId})`, {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** Await every in-flight background dispatch. Called by app.shutdown(). */
  async drainPendingDispatches(): Promise<void> {
    if (this._pendingDispatches.size === 0) return;
    await Promise.allSettled([...this._pendingDispatches]);
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
      try {
        await this.app.launcher.kill(session.session_id);
      } catch {
        // best-effort cleanup; a missing/dead tmux session is expected on resume
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
      this.kickDispatch(id, () => {});
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
      const flow = await import("../state/flow.js");
      const action = flow.getStageAction(this.app, flowName, stage);
      if (action.type === "agent" || action.type === "fork" || action.type === "fan_out") return "agent";
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
        const flow = await import("../state/flow.js");
        const action = flow.getStageAction(this.app, session.flow, session.stage);
        if (action.type !== "action" || !action.action) return;
        const { executeAction } = await import("./actions/index.js");
        const result = await executeAction(this.app, sessionId, action.action);
        if (!result.ok) {
          await this.events.log(sessionId, "dispatch_failed", {
            actor: "system",
            data: { reason: `action '${action.action}' failed: ${result.message}` },
          });
        }
      } catch (err) {
        await this.events.log(sessionId, "dispatch_failed", {
          actor: "system",
          data: { reason: err instanceof Error ? err.message : String(err) },
        });
      }
    })();
    this._pendingDispatches.add(promise);
    promise.finally(() => this._pendingDispatches.delete(promise)).catch(() => {});
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
    const { interrupt: legacyInterrupt } = await import("./session-lifecycle.js");
    return legacyInterrupt(this.app, id);
  }

  /**
   * Archive a session for later reference.
   * Delegates to session-orchestration.ts archive().
   */
  async archive(id: string): Promise<SessionOpResult> {
    const { archive: legacyArchive } = await import("./session-lifecycle.js");
    return legacyArchive(this.app, id);
  }

  /**
   * Restore an archived session back to stopped.
   * Delegates to session-orchestration.ts restore().
   */
  async restore(id: string): Promise<SessionOpResult> {
    const { restore: legacyRestore } = await import("./session-lifecycle.js");
    return legacyRestore(this.app, id);
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
   * Delegates to session.ts dispatch() which owns tmux/executor/flow logic.
   */
  async dispatch(id: string, opts?: { onLog?: (msg: string) => void }): Promise<SessionOpResult> {
    const { dispatch: legacyDispatch } = await import("./dispatch.js");
    return legacyDispatch(this.app, id, opts);
  }

  /**
   * Advance a session to the next flow stage.
   * Delegates to session.ts advance() which owns gate evaluation and flow progression.
   */
  async advance(id: string, force?: boolean): Promise<SessionOpResult> {
    const { advance: legacyAdvance } = await import("./stage-advance.js");
    return legacyAdvance(this.app, id, force);
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
    const { waitForCompletion: legacyWait } = await import("./session-lifecycle.js");
    return legacyWait(this.app, id, opts);
  }

  /**
   * Fork a session: create a new session from the same point in the flow.
   */
  async fork(id: string, name?: string): Promise<SessionOpResult> {
    const { forkSession } = await import("./session-lifecycle.js");
    // session.ts has a narrower local SessionOpResult (no `message` on success)
    return forkSession(this.app, id, name, {
      onCreated: (sid) => this.emitSessionCreated(sid),
    }) as unknown as SessionOpResult;
  }

  /**
   * Clone a session: deep copy including claude_session_id for --resume.
   */
  async clone(id: string, name?: string): Promise<SessionOpResult> {
    const { cloneSession } = await import("./session-lifecycle.js");
    return cloneSession(this.app, id, name, {
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
      model?: string;
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
    const { handoff: legacyHandoff } = await import("./stage-advance.js");
    return legacyHandoff(this.app, id, agent, instructions);
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
