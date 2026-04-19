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
  start(opts: CreateSessionOpts): Session {
    const session = this.sessions.create(opts);

    // Apply agent override if specified
    if (opts.agent) {
      this.sessions.update(session.id, { agent: opts.agent } as Partial<Session>);
    }

    // Log creation event
    this.events.log(session.id, "session_created", {
      actor: "system",
      data: {
        flow: opts.flow ?? "default",
        repo: opts.repo ?? null,
        agent: opts.agent ?? null,
      },
    });

    return this.sessions.get(session.id)!;
  }

  /**
   * Stop a session. Idempotent -- already-stopped/completed/failed returns ok.
   * When a running process exists (session_id set) and orchestration is available,
   * delegates for proper tmux/provider cleanup. Otherwise does a local state transition.
   */
  async stop(id: string, opts?: { force?: boolean }): Promise<SessionOpResult> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    // Idempotent: already in terminal state with no running process
    if (!opts?.force && ["stopped", "completed", "failed"].includes(session.status) && !session.session_id) {
      return { ok: true, message: "OK", sessionId: id };
    }

    // If there's a running process and AppContext is available, delegate to
    // orchestration for full cleanup (tmux kill, provider cleanup, hooks removal)
    if (session.session_id) {
      try {
        const { stop: orchStop } = await import("./session-orchestration.js");
        return orchStop(this.app, id, opts);
      } catch {
        // AppContext not available (e.g. unit tests) -- fall through to local stop
      }
    }

    // Local state transition -- no process cleanup needed (or not available)
    this.sessions.update(id, { status: "stopped" as SessionStatus, error: null, session_id: null } as Partial<Session>);
    this.events.log(id, "session_stopped", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { session_id: session.session_id, agent: session.agent },
    });

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Stop all running sessions. Used during test teardown and hosted shutdown.
   * Goes through the proper stop sequence for each (provider kill + cleanup).
   */
  async stopAll(): Promise<void> {
    const { stop: orchStop } = await import("./session-orchestration.js");
    const all = this.sessions.list({});
    for (const s of all) {
      if (s.session_id) {
        await orchStop(this.app, s.id, { force: true });
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
        this.events.log(sessionId, "session_created_listener_error", {
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
      .catch((err) => {
        this.events.log(sessionId, "dispatch_failed", {
          actor: "system",
          data: { reason: err instanceof Error ? err.message : String(err) },
        });
      })
      .then(() => {
        onDispatched(this.sessions.get(sessionId));
      });
    this._pendingDispatches.add(promise);
    promise.finally(() => this._pendingDispatches.delete(promise)).catch(() => {});
  }

  /** Await every in-flight background dispatch. Called by app.shutdown(). */
  async drainPendingDispatches(): Promise<void> {
    if (this._pendingDispatches.size === 0) return;
    await Promise.allSettled([...this._pendingDispatches]);
  }

  /**
   * Persist a session input file on disk under `<arkDir>/inputs/<id>/<name>`.
   * Returns the absolute path callers should store in
   * `session.config.inputs.files[<role>]`. The per-upload directory keeps
   * same-name files for different roles from stomping each other.
   */
  async saveInput(opts: {
    name: string;
    role: string;
    content: string;
    contentEncoding?: "base64" | "utf-8";
  }): Promise<{ path: string }> {
    const { join, basename } = await import("path");
    const { mkdirSync, writeFileSync } = await import("fs");
    const safeName = basename(opts.name).replace(/[^\w.\-]/g, "_");
    const safeRole = opts.role.replace(/[^\w.\-]/g, "_");
    const dir = join(this.app.arkDir, "inputs", `${Date.now().toString(36)}-${safeRole}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safeName);
    const encoding = opts.contentEncoding ?? "utf-8";
    if (encoding === "base64") {
      writeFileSync(path, Buffer.from(opts.content, "base64"));
    } else {
      writeFileSync(path, opts.content, "utf-8");
    }
    return { path };
  }

  /**
   * Resume a stopped/failed session back to ready.
   * Port of session.ts resume() -- does NOT auto-dispatch (caller handles that).
   */
  async resume(id: string): Promise<SessionOpResult> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    // Guard: can't resume completed sessions
    if (session.status === "completed") {
      return { ok: false, message: "Cannot resume a completed session" };
    }

    // Clear runtime state, set to ready
    this.sessions.update(id, {
      status: "ready" as SessionStatus,
      error: null,
      breakpoint_reason: null,
      attached_by: null,
      session_id: null,
    } as Partial<Session>);

    this.events.log(id, "session_resumed", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { from_status: session.status },
    });

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Mark session as completed.
   * Port of session.ts complete() -- simplified: just marks ready + logs event.
   * The advance() call is the caller's responsibility.
   */
  complete(id: string): SessionOpResult {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    this.events.log(id, "stage_completed", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { note: "Manually completed" },
    });

    this.messages.markRead(id);
    this.sessions.update(id, { status: "ready" as SessionStatus, session_id: null } as Partial<Session>);

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Pause a session (set to blocked).
   * Port of session.ts pause().
   */
  pause(id: string, reason?: string): SessionOpResult {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    this.sessions.update(id, {
      status: "blocked" as SessionStatus,
      breakpoint_reason: reason ?? "User paused",
    } as Partial<Session>);

    this.events.log(id, "session_paused", {
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
    const { interrupt: legacyInterrupt } = await import("./session-orchestration.js");
    return legacyInterrupt(this.app, id);
  }

  /**
   * Archive a session for later reference.
   * Delegates to session-orchestration.ts archive().
   */
  async archive(id: string): Promise<SessionOpResult> {
    const { archive: legacyArchive } = await import("./session-orchestration.js");
    return legacyArchive(this.app, id);
  }

  /**
   * Restore an archived session back to stopped.
   * Delegates to session-orchestration.ts restore().
   */
  async restore(id: string): Promise<SessionOpResult> {
    const { restore: legacyRestore } = await import("./session-orchestration.js");
    return legacyRestore(this.app, id);
  }

  /**
   * Soft-delete a session (90s undo window).
   * Port of session.ts deleteSessionAsync() -- simplified: no tmux/provider
   * cleanup (caller handles), just state transition.
   */
  async delete(id: string): Promise<SessionOpResult> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    this.sessions.softDelete(id);

    this.events.log(id, "session_deleted", { actor: "user" });

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Restore a soft-deleted session.
   * Port of session.ts undeleteSessionAsync().
   */
  async undelete(id: string): Promise<SessionOpResult> {
    const restored = this.sessions.undelete(id);
    if (!restored) return { ok: false, message: `Session ${id} not found or not deleted` };

    this.events.log(id, "session_undeleted", { actor: "user" });

    return { ok: true, message: "OK", sessionId: id };
  }

  // ── Delegating methods (complex orchestration -- call through to session.ts) ──

  /**
   * Dispatch a session: resolve agent, build task, launch executor.
   * Delegates to session.ts dispatch() which owns tmux/executor/flow logic.
   */
  async dispatch(id: string, opts?: { onLog?: (msg: string) => void }): Promise<SessionOpResult> {
    const { dispatch: legacyDispatch } = await import("./session-orchestration.js");
    return legacyDispatch(this.app, id, opts);
  }

  /**
   * Advance a session to the next flow stage.
   * Delegates to session.ts advance() which owns gate evaluation and flow progression.
   */
  async advance(id: string, force?: boolean): Promise<SessionOpResult> {
    const { advance: legacyAdvance } = await import("./session-orchestration.js");
    return legacyAdvance(this.app, id, force);
  }

  /**
   * Get captured output from a running session's tmux pane.
   */
  async getOutput(id: string, opts?: { lines?: number; ansi?: boolean }): Promise<string> {
    const { getOutput: legacyGetOutput } = await import("./session-orchestration.js");
    return legacyGetOutput(this.app, id, opts);
  }

  /**
   * Send a message to a running session's tmux pane.
   */
  async send(id: string, message: string): Promise<SessionOpResult> {
    const { send: legacySend } = await import("./session-orchestration.js");
    return legacySend(this.app, id, message);
  }

  /**
   * Poll until session reaches a terminal state (completed/failed/stopped).
   */
  async waitForCompletion(
    id: string,
    opts?: { timeoutMs?: number; pollMs?: number; onStatus?: (status: string) => void },
  ): Promise<{ session: Session | null; timedOut: boolean }> {
    const { waitForCompletion: legacyWait } = await import("./session-orchestration.js");
    return legacyWait(this.app, id, opts);
  }

  /**
   * Fork a session: create a new session from the same point in the flow.
   */
  async fork(id: string, name?: string): Promise<SessionOpResult> {
    const { forkSession } = await import("./session-orchestration.js");
    // session.ts has a narrower local SessionOpResult (no `message` on success)
    return forkSession(this.app, id, name) as unknown as SessionOpResult;
  }

  /**
   * Clone a session: deep copy including claude_session_id for --resume.
   */
  async clone(id: string, name?: string): Promise<SessionOpResult> {
    const { cloneSession } = await import("./session-orchestration.js");
    return cloneSession(this.app, id, name) as unknown as SessionOpResult;
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
    const { spawnSubagent } = await import("./session-orchestration.js");
    return spawnSubagent(this.app, parentId, opts);
  }

  /**
   * Fan-out: create parallel child sessions from a parent.
   */
  async fanOut(sessionId: string, opts: { tasks: Array<{ summary: string; agent?: string; flow?: string }> }) {
    const { fanOut } = await import("./session-orchestration.js");
    return fanOut(this.app, sessionId, opts);
  }

  /**
   * Handoff: clone session to a different agent and dispatch.
   */
  async handoff(id: string, agent: string, instructions?: string): Promise<SessionOpResult> {
    const { handoff: legacyHandoff } = await import("./session-orchestration.js");
    return legacyHandoff(this.app, id, agent, instructions);
  }

  /**
   * Get a diff summary for a session's worktree branch vs its base branch.
   */
  async worktreeDiff(id: string, opts?: { base?: string }): Promise<any> {
    const { worktreeDiff: legacyDiff } = await import("./session-orchestration.js");
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
    const { finishWorktree: legacyFinish } = await import("./session-orchestration.js");
    return legacyFinish(this.app, id, opts);
  }

  /**
   * Rebase a session's branch onto the base branch.
   */
  async rebaseOntoBase(id: string, opts?: { base?: string }): Promise<SessionOpResult> {
    const { rebaseOntoBase: legacyRebase } = await import("./session-orchestration.js");
    return legacyRebase(this.app, id, opts);
  }

  /**
   * Create a GitHub PR from a session's worktree branch.
   */
  async createWorktreePR(
    id: string,
    opts?: { title?: string; body?: string; base?: string; draft?: boolean },
  ): Promise<SessionOpResult & { pr_url?: string }> {
    const { createWorktreePR: legacyCreatePR } = await import("./session-orchestration.js");
    return legacyCreatePR(this.app, id, opts);
  }

  /**
   * Join forked children back into parent session.
   */
  async join(parentId: string, force?: boolean): Promise<SessionOpResult> {
    const { joinFork } = await import("./session-orchestration.js");
    return joinFork(this.app, parentId, force);
  }

  /**
   * Approve a review gate and force-advance past it.
   */
  async approveReviewGate(id: string): Promise<SessionOpResult> {
    const { approveReviewGate: legacyApprove } = await import("./session-orchestration.js");
    return legacyApprove(this.app, id);
  }

  // ── Query helpers ─────────────────────────────────────────────────────────

  get(id: string): Session | null {
    return this.sessions.get(id);
  }

  list(filters?: Parameters<SessionRepository["list"]>[0]): Session[] {
    return this.sessions.list(filters);
  }
}
