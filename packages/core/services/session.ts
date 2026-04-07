/**
 * SessionService — owns session lifecycle orchestration.
 *
 * Core lifecycle methods (start, stop, resume, complete, pause, delete, undelete)
 * and state-machine methods (applyHookStatus, applyReport) are fully ported.
 *
 * Complex methods (dispatch, advance, fork, clone, etc.) delegate to the
 * existing packages/core/session.ts functions for now — will be fully ported
 * in a later pass.
 */

import type {
  Session,
  SessionStatus,
  SessionConfig,
  CreateSessionOpts,
  SessionOpResult,
} from "../../types/index.js";
import type { SessionRepository } from "../repositories/session.js";
import type { EventRepository } from "../repositories/event.js";
import type { MessageRepository } from "../repositories/message.js";

// ── HookStatusResult ─────────────────────────────────────────────────────────

export interface HookStatusResult {
  newStatus?: string;
  shouldIndex?: boolean;
  claudeSessionId?: string;
  /** Store updates to apply */
  updates?: Partial<Session>;
  /** Events to log */
  events?: Array<{ type: string; opts: { actor?: string; stage?: string; data?: Record<string, unknown> } }>;
}

// ── ReportResult ─────────────────────────────────────────────────────────────

export interface ReportResult {
  /** Store updates to apply to the session */
  updates: Partial<Session>;
  /** Whether to call advance() after applying updates */
  shouldAdvance?: boolean;
  /** Whether to auto-dispatch next stage after advance */
  shouldAutoDispatch?: boolean;
  /** Events to emit on the event bus */
  busEvents?: Array<{ type: string; sessionId: string; data: Record<string, unknown> }>;
  /** Events to log to the store */
  logEvents?: Array<{ type: string; opts: { stage?: string; actor?: string; data?: Record<string, unknown> } }>;
  /** Message to store for TUI chat view */
  message?: { role: string; content: string; type: string };
  /** PR URL detected from report */
  prUrl?: string;
}

// ── OutboundMessage (minimal interface for applyReport) ──────────────────────

export interface OutboundMessage {
  type: "progress" | "completed" | "question" | "error";
  sessionId: string;
  stage: string;
  [key: string]: unknown;
}

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

  // ── State machine (fully ported) ──────────────────────────────────────────

  /**
   * Process a hook status event and return the computed state transition.
   * Pure logic — caller is responsible for applying updates to the store.
   *
   * Port of session.ts applyHookStatus() — core guard logic preserved.
   * Termination-condition checks and transcript parsing are omitted (kept
   * in the orchestration layer where flow definitions are available).
   */
  applyHookStatus(
    session: Session,
    hookEvent: string,
    payload: Record<string, unknown>,
    opts?: { isManualGate?: boolean },
  ): HookStatusResult {
    const result: HookStatusResult = { events: [] };
    const isManualGate = opts?.isManualGate ?? false;

    const statusMap: Record<string, string> = {
      SessionStart: "running",
      UserPromptSubmit: "running",
      StopFailure: isManualGate ? "running" : "failed",
      SessionEnd: isManualGate ? "running" : "completed",
    };

    let newStatus = statusMap[hookEvent];

    // CRITICAL guards: don't override terminal status — late hooks can fire
    // after session is done or manually stopped
    if (newStatus && session.status === "completed" && newStatus !== "completed") {
      newStatus = undefined;
    }
    if (newStatus && session.status === "failed" && newStatus === "running") {
      newStatus = undefined;
    }
    if (newStatus && session.status === "stopped" && newStatus !== "stopped") {
      newStatus = undefined;
    }

    // Notification hook: permission/idle prompts -> waiting
    if (hookEvent === "Notification") {
      const matcher = String(payload.matcher ?? "");
      if (matcher.includes("permission_prompt") || matcher.includes("idle_prompt")) {
        newStatus = "waiting";
      }
    }

    // Always log the hook event
    result.events!.push({
      type: "hook_status",
      opts: { actor: "hook", data: { event: hookEvent, ...payload } as Record<string, unknown> },
    });

    // For manual gate: log errors/completions as events but don't change status
    if (isManualGate && (hookEvent === "StopFailure" || hookEvent === "SessionEnd")) {
      const errorMsg = payload.error ?? payload.error_details;
      if (errorMsg) {
        result.events!.push({
          type: "agent_error",
          opts: { actor: "agent", data: { error: String(errorMsg), event: hookEvent } },
        });
      }
    }

    if (newStatus) {
      const updates: Partial<Session> = { status: newStatus as SessionStatus };
      if (newStatus === "failed") {
        updates.error = String(payload.error ?? payload.error_details ?? "unknown error");
      }
      // Clear stale breakpoint when resuming from waiting
      if (newStatus === "running" && session.status === "waiting") {
        updates.breakpoint_reason = null;
      }
      result.updates = updates;
      result.newStatus = newStatus;
    }

    return result;
  }

  /**
   * Process an agent channel report and return the computed state transition.
   * Pure logic — caller is responsible for applying updates + dispatching events.
   *
   * Port of session.ts applyReport().
   */
  applyReport(sessionId: string, report: OutboundMessage): ReportResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { updates: {}, logEvents: [], busEvents: [] };
    }
    const result: ReportResult = { updates: {}, logEvents: [], busEvents: [] };

    // Log event
    result.logEvents!.push({
      type: `agent_${report.type}`,
      opts: {
        stage: report.stage,
        actor: "agent",
        data: report as unknown as Record<string, unknown>,
      },
    });

    // Build message content for TUI chat view
    const r = report as unknown as Record<string, unknown>;
    const contentByType: Record<string, string | undefined> = {
      completed: (r.summary || r.message) as string | undefined,
      question: (r.question || r.message) as string | undefined,
      error: (r.error || r.message) as string | undefined,
      progress: (r.message || r.summary) as string | undefined,
    };
    let content = contentByType[report.type] || JSON.stringify(report);

    // Enrich with files, commits, PR URL when available
    const extras: string[] = [];
    if (r.pr_url) extras.push(`PR: ${r.pr_url}`);
    if (Array.isArray(r.filesChanged) && r.filesChanged.length > 0) {
      extras.push(`Files: ${(r.filesChanged as string[]).join(", ")}`);
    }
    if (Array.isArray(r.commits) && r.commits.length > 0) {
      extras.push(`Commits: ${(r.commits as string[]).join(", ")}`);
    }
    if (extras.length > 0) content += "\n" + extras.join("\n");
    result.message = { role: "agent", content, type: report.type };

    // Emit to event bus
    result.busEvents!.push({
      type: `agent_${report.type}`,
      sessionId,
      data: { stage: report.stage, data: report as unknown as Record<string, unknown> },
    });

    // Handle by type
    switch (report.type) {
      case "completed": {
        const rr = report as unknown as Record<string, unknown>;
        const cfg: SessionConfig = {
          ...session.config,
          completion_summary: rr.summary as string | undefined,
          filesChanged: rr.filesChanged as string[] | undefined,
          commits: rr.commits as string[] | undefined,
        };
        result.updates.config = cfg;

        // Without flow definition access we default to auto-gate behavior.
        // The orchestration layer can override this with manual-gate logic.
        result.updates.status = "ready" as SessionStatus;
        result.updates.session_id = null;
        result.shouldAdvance = true;
        result.shouldAutoDispatch = true;
        break;
      }
      case "question": {
        const qr = report as unknown as Record<string, unknown>;
        result.updates.status = "waiting" as SessionStatus;
        result.updates.breakpoint_reason =
          (qr.question ?? qr.message) as string | null;
        break;
      }
      case "error": {
        const er = report as unknown as Record<string, unknown>;
        result.updates.status = "failed" as SessionStatus;
        result.updates.error = (er.error ?? er.message) as string | null;
        break;
      }
      case "progress": {
        // Agent is actively reporting — ensure status reflects that.
        if (session.status === "waiting") {
          result.updates.status = "running" as SessionStatus;
          result.updates.breakpoint_reason = null;
        }
        break;
      }
    }

    // PR URL from agent report
    const prUrl = (report as unknown as Record<string, unknown>).pr_url as string | undefined;
    if (prUrl && !session.pr_url) {
      result.prUrl = prUrl;
    }

    return result;
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
