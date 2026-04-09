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

import type {
  Session,
  SessionStatus,
  CreateSessionOpts,
  SessionOpResult,
} from "../../types/index.js";
import type { SessionRepository } from "../repositories/session.js";
import type { EventRepository } from "../repositories/event.js";
import type { MessageRepository } from "../repositories/message.js";

// ── SessionService ───────────────────────────────────────────────────────────

export class SessionService {
  constructor(
    private sessions: SessionRepository,
    private events: EventRepository,
    private messages: MessageRepository,
  ) {}

  // ── Core lifecycle (fully ported) ─────────────────────────────────────────

  /**
   * Create a new session with sensible defaults.
   * Port of session.ts startSession() — simplified: no flow-stage resolution,
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
   * Stop a session. Idempotent — already-stopped/completed/failed returns ok.
   * Port of session.ts stop() — simplified: no tmux/provider kill (that stays
   * in the orchestration layer), just state transition + events.
   */
  async stop(id: string): Promise<SessionOpResult> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    // Idempotent: already in terminal state
    if (["stopped", "completed", "failed"].includes(session.status)) {
      return { ok: true, message: "OK", sessionId: id };
    }

    // Transition to stopped — preserve claude_session_id for resume
    this.sessions.update(id, {
      status: "stopped" as SessionStatus,
      error: null,
      session_id: null,
    } as Partial<Session>);

    this.events.log(id, "session_stopped", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: {
        session_id: session.session_id,
        agent: session.agent,
        from_status: session.status,
      },
    });

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Resume a stopped/failed session back to ready.
   * Port of session.ts resume() — does NOT auto-dispatch (caller handles that).
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
   * Port of session.ts complete() — simplified: just marks ready + logs event.
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
    return legacyInterrupt(id);
  }

  /**
   * Archive a session for later reference.
   * Delegates to session-orchestration.ts archive().
   */
  async archive(id: string): Promise<SessionOpResult> {
    const { archive: legacyArchive } = await import("./session-orchestration.js");
    return legacyArchive(id);
  }

  /**
   * Restore an archived session back to stopped.
   * Delegates to session-orchestration.ts restore().
   */
  async restore(id: string): Promise<SessionOpResult> {
    const { restore: legacyRestore } = await import("./session-orchestration.js");
    return legacyRestore(id);
  }

  /**
   * Soft-delete a session (90s undo window).
   * Port of session.ts deleteSessionAsync() — simplified: no tmux/provider
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

  // ── Delegating methods (complex orchestration — call through to session.ts) ──

  /**
   * Dispatch a session: resolve agent, build task, launch executor.
   * Delegates to session.ts dispatch() which owns tmux/executor/flow logic.
   */
  async dispatch(id: string, opts?: { onLog?: (msg: string) => void }): Promise<SessionOpResult> {
    const { dispatch: legacyDispatch } = await import("./session-orchestration.js");
    return legacyDispatch(id, opts);
  }

  /**
   * Advance a session to the next flow stage.
   * Delegates to session.ts advance() which owns gate evaluation and flow progression.
   */
  async advance(id: string, force?: boolean): Promise<SessionOpResult> {
    const { advance: legacyAdvance } = await import("./session-orchestration.js");
    return legacyAdvance(id, force);
  }

  /**
   * Get captured output from a running session's tmux pane.
   */
  async getOutput(id: string, opts?: { lines?: number; ansi?: boolean }): Promise<string> {
    const { getOutput: legacyGetOutput } = await import("./session-orchestration.js");
    return legacyGetOutput(id, opts);
  }

  /**
   * Send a message to a running session's tmux pane.
   */
  async send(id: string, message: string): Promise<SessionOpResult> {
    const { send: legacySend } = await import("./session-orchestration.js");
    return legacySend(id, message);
  }

  /**
   * Poll until session reaches a terminal state (completed/failed/stopped).
   */
  async waitForCompletion(
    id: string,
    opts?: { timeoutMs?: number; pollMs?: number; onStatus?: (status: string) => void },
  ): Promise<{ session: Session | null; timedOut: boolean }> {
    const { waitForCompletion: legacyWait } = await import("./session-orchestration.js");
    return legacyWait(id, opts);
  }

  /**
   * Fork a session: create a new session from the same point in the flow.
   */
  async fork(id: string, name?: string): Promise<SessionOpResult> {
    const { forkSession } = await import("./session-orchestration.js");
    // session.ts has a narrower local SessionOpResult (no `message` on success)
    return forkSession(id, name) as unknown as SessionOpResult;
  }

  /**
   * Clone a session: deep copy including claude_session_id for --resume.
   */
  async clone(id: string, name?: string): Promise<SessionOpResult> {
    const { cloneSession } = await import("./session-orchestration.js");
    return cloneSession(id, name) as unknown as SessionOpResult;
  }

  /**
   * Spawn a subagent session under a parent.
   */
  async spawn(parentId: string, opts: {
    task: string;
    agent?: string;
    model?: string;
    group_name?: string;
    extensions?: string[];
  }): Promise<SessionOpResult> {
    const { spawnSubagent } = await import("./session-orchestration.js");
    return spawnSubagent(parentId, opts);
  }

  /**
   * Fan-out: create parallel child sessions from a parent.
   */
  async fanOut(sessionId: string, opts: { tasks: Array<{ summary: string; agent?: string; flow?: string }> }) {
    const { fanOut } = await import("./session-orchestration.js");
    return fanOut(sessionId, opts);
  }

  /**
   * Handoff: clone session to a different agent and dispatch.
   */
  async handoff(id: string, agent: string, instructions?: string): Promise<SessionOpResult> {
    const { handoff: legacyHandoff } = await import("./session-orchestration.js");
    return legacyHandoff(id, agent, instructions);
  }

  /**
   * Get a diff summary for a session's worktree branch vs its base branch.
   */
  async worktreeDiff(id: string, opts?: { base?: string }): Promise<any> {
    const { worktreeDiff: legacyDiff } = await import("./session-orchestration.js");
    return legacyDiff(id, opts);
  }

  /**
   * Finish a worktree: merge back and clean up.
   */
  async finishWorktree(id: string, opts?: {
    into?: string;
    noMerge?: boolean;
    keepBranch?: boolean;
    createPR?: boolean;
  }): Promise<SessionOpResult> {
    const { finishWorktree: legacyFinish } = await import("./session-orchestration.js");
    return legacyFinish(id, opts);
  }

  /**
   * Create a GitHub PR from a session's worktree branch.
   */
  async createWorktreePR(id: string, opts?: { title?: string; body?: string; base?: string; draft?: boolean }): Promise<SessionOpResult & { pr_url?: string }> {
    const { createWorktreePR: legacyCreatePR } = await import("./session-orchestration.js");
    return legacyCreatePR(id, opts);
  }

  /**
   * Join forked children back into parent session.
   */
  async join(parentId: string, force?: boolean): Promise<SessionOpResult> {
    const { joinFork } = await import("./session-orchestration.js");
    return joinFork(parentId, force);
  }

  /**
   * Approve a review gate and force-advance past it.
   */
  async approveReviewGate(id: string): Promise<SessionOpResult> {
    const { approveReviewGate: legacyApprove } = await import("./session-orchestration.js");
    return legacyApprove(id);
  }

  // ── Query helpers ─────────────────────────────────────────────────────────

  get(id: string): Session | null {
    return this.sessions.get(id);
  }

  list(filters?: Parameters<SessionRepository["list"]>[0]): Session[] {
    return this.sessions.list(filters);
  }
}
