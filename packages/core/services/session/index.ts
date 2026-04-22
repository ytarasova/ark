/**
 * SessionLifecycle -- start, stop, fork/clone, pause/archive/restore,
 * interrupt, wait, verify, review-gate. Composes four internal classes over
 * a shared `SessionLifecycleDeps` cradle-slice.
 *
 * Access via the DI container: `app.sessionLifecycle.X`. The old free-function
 * barrel (`session-lifecycle.ts`) has been retired; every caller now uses the
 * class through AppContext.
 */

import type { Session } from "../../../types/index.js";
import { SessionCreator } from "./create.js";
import { SessionTerminator } from "./terminate.js";
import { SessionSuspender } from "./suspend.js";
import { SessionForker } from "./fork-clone.js";
import { SessionReviewer } from "./review.js";
import type {
  LifecycleHooks,
  SessionLifecycleDeps,
  SessionOpResult,
  StartSessionOpts,
  VerificationResult,
  VerifyScriptRunner,
} from "./types.js";

export type {
  LifecycleHooks,
  SessionLifecycleDeps,
  SessionOpResult,
  StartSessionOpts,
  VerificationResult,
  VerifyScriptRunner,
} from "./types.js";
export { resolveGitHubUrl } from "./create.js";
export { renderReworkPrompt } from "./review.js";

export class SessionLifecycle {
  private readonly creator: SessionCreator;
  private readonly terminator: SessionTerminator;
  private readonly suspender: SessionSuspender;
  private readonly forker: SessionForker;
  private readonly reviewer: SessionReviewer;

  constructor(deps: SessionLifecycleDeps) {
    this.creator = new SessionCreator(deps);
    this.terminator = new SessionTerminator(deps);
    this.suspender = new SessionSuspender(deps);
    this.forker = new SessionForker(deps);
    this.reviewer = new SessionReviewer(deps);
  }

  // ── Create ───────────────────────────────────────────────────────────────

  start(opts: StartSessionOpts, hooks?: LifecycleHooks): Promise<Session> {
    return this.creator.start(opts, hooks);
  }

  recordSessionUsage(
    session: Session,
    usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number },
    provider: string,
    source: string,
  ): void {
    this.creator.recordUsage(session, usage, provider, source);
  }

  // ── Terminate ────────────────────────────────────────────────────────────

  stop(sessionId: string, opts?: { force?: boolean }): Promise<{ ok: boolean; message: string }> {
    return this.terminator.stop(sessionId, opts);
  }

  deleteSession(sessionId: string): Promise<{ ok: boolean; message: string }> {
    return this.terminator.deleteSession(sessionId);
  }

  undeleteSession(sessionId: string): Promise<{ ok: boolean; message: string }> {
    return this.terminator.undeleteSession(sessionId);
  }

  cleanupOnTerminal(sessionId: string): Promise<void> {
    return this.terminator.cleanupOnTerminal(sessionId);
  }

  // ── Suspend / Resume ─────────────────────────────────────────────────────

  pause(sessionId: string, reason?: string): Promise<{ ok: boolean; message: string }> {
    return this.suspender.pause(sessionId, reason);
  }
  archive(sessionId: string): Promise<{ ok: boolean; message: string }> {
    return this.suspender.archive(sessionId);
  }
  restore(sessionId: string): Promise<{ ok: boolean; message: string }> {
    return this.suspender.restore(sessionId);
  }
  interrupt(sessionId: string): Promise<{ ok: boolean; message: string }> {
    return this.suspender.interrupt(sessionId);
  }
  waitForCompletion(
    sessionId: string,
    opts?: { timeoutMs?: number; pollMs?: number; onStatus?: (status: string) => void },
  ): Promise<{ session: Session | null; timedOut: boolean }> {
    return this.suspender.waitForCompletion(sessionId, opts);
  }

  // ── Fork / Clone ─────────────────────────────────────────────────────────

  fork(sessionId: string, newName?: string, hooks?: LifecycleHooks): Promise<SessionOpResult> {
    return this.forker.fork(sessionId, newName, hooks);
  }
  clone(sessionId: string, newName?: string, hooks?: LifecycleHooks): Promise<SessionOpResult> {
    return this.forker.clone(sessionId, newName, hooks);
  }

  // ── Review ───────────────────────────────────────────────────────────────

  runVerification(
    sessionId: string,
    opts?: { runScript?: VerifyScriptRunner; timeoutMs?: number },
  ): Promise<VerificationResult> {
    return this.reviewer.runVerification(sessionId, opts);
  }
  approveReviewGate(
    sessionId: string,
    advanceOverride?: (id: string, force?: boolean) => Promise<{ ok: boolean; message: string }>,
  ): Promise<{ ok: boolean; message: string }> {
    return this.reviewer.approve(sessionId, advanceOverride);
  }
  rejectReviewGate(
    sessionId: string,
    reason: string,
    dispatchOverride?: (id: string) => Promise<{ ok: boolean; message: string }>,
  ): Promise<{ ok: boolean; message: string }> {
    return this.reviewer.reject(sessionId, reason, dispatchOverride);
  }
}
