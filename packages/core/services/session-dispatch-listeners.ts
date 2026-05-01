/**
 * SessionDispatchListeners -- decoupled session_created -> dispatch pump.
 *
 * Carved out of SessionService, which had accumulated six concerns around
 * this single lifecycle moment (listener registry, default-dispatcher
 * registration, kickDispatch, pending-dispatch drain, dispatch-failure
 * marking). The mutable state here is intentionally private to a small
 * class so SessionService can delegate without exposing the internals.
 */
import type { Session, SessionStatus } from "../../types/index.js";
import type { SessionRepository } from "../repositories/session.js";
import type { EventRepository } from "../repositories/event.js";
import { logWarn } from "../observability/structured-log.js";

type SessionCreatedListener = (sessionId: string) => void;
type DispatchFn = (sessionId: string) => Promise<{ ok: boolean; message?: string }>;

/**
 * Allow-list of `dispatch()` success messages where the session is *expected*
 * to remain at status=ready. Without this, a strict post-condition check on
 * `result.ok === true` would mark every legitimate-no-launch path as failed.
 *
 * Concrete cases this covers (from the existing dispatch surface):
 *   - "Already running"        -- duplicate-dispatch noop
 *   - "Executed action 'X'"    -- action stages don't launch a tmux session
 *   - "Forked into N sessions" -- fan-out parent intentionally stays ready
 *   - "Dispatched to worker"   -- hosted-mode handoff to scheduler
 *
 * Anything else returning `ok:true` while the session is still at `ready`
 * indicates a silent-launch-failure: log + flip to failed.
 */
const ALLOWED_NO_LAUNCH_MESSAGES: ReadonlyArray<string | RegExp> = [
  "Already running",
  /^Executed action /,
  /^Forked into \d+ sessions?$/,
  /^Dispatched to worker/,
];

function messageAllowsNoLaunch(msg: string | undefined): boolean {
  if (!msg) return false;
  return ALLOWED_NO_LAUNCH_MESSAGES.some((p) => (typeof p === "string" ? p === msg : p.test(msg)));
}

/**
 * Flip a session to `failed` after a dispatch-time error. Kept lenient:
 * if the session was already marked terminal by another path we skip the
 * write so we don't clobber a more specific status (e.g. cancelled).
 *
 * Shared between `SessionDispatchListeners.kickDispatch` and
 * `HandoffMediator.mediate` so both auto-dispatch paths produce the same
 * `dispatch_failed` event + status-update shape on failure.
 */
export async function markDispatchFailedShared(
  sessions: SessionRepository,
  events: EventRepository,
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    await events.log(sessionId, "dispatch_failed", { actor: "system", data: { reason } });
  } catch (err) {
    logWarn("session", `markDispatchFailedShared: failed to log dispatch_failed event (sessionId=${sessionId})`, {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const existing = await sessions.get(sessionId);
    if (!existing) return;
    if (existing.status === "failed" || existing.status === "completed" || existing.status === "cancelled") return;
    await sessions.update(sessionId, {
      status: "failed" as SessionStatus,
      error: reason,
    } as Partial<Session>);
  } catch (err) {
    logWarn("session", `markDispatchFailedShared: failed to persist status (sessionId=${sessionId})`, {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export class SessionDispatchListeners {
  private readonly listeners: SessionCreatedListener[] = [];
  private readonly pendingDispatches = new Set<Promise<unknown>>();
  private defaultDispatcherUnregister: (() => void) | null = null;

  constructor(
    private readonly sessions: SessionRepository,
    private readonly events: EventRepository,
    private readonly dispatch: DispatchFn,
  ) {}

  /**
   * Subscribe to the `session_created` lifecycle moment. Orchestration code
   * (start, fork, clone, spawn) calls `emit(sessionId)` after a session row
   * has been committed, and every registered listener fires synchronously.
   * Returns an `unsubscribe` callback.
   */
  subscribe(listener: SessionCreatedListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * Fire every subscribed listener. Listener errors are logged as events
   * and otherwise swallowed -- one bad subscriber must not block dispatch.
   */
  emit(sessionId: string): void {
    for (const l of this.listeners) {
      try {
        l(sessionId);
      } catch (err) {
        void this.events.log(sessionId, "session_created_listener_error", {
          actor: "system",
          data: { reason: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  /**
   * Register the default `session_created -> background dispatch` listener.
   * Safe to call repeatedly (e.g. per-test `beforeEach`): replaces any
   * previous default registration, so listeners don't accumulate and fan
   * out into duplicate dispatches.
   */
  registerDefaultDispatcher(onDispatched: (session: Session | null) => void): () => void {
    if (this.defaultDispatcherUnregister) {
      this.defaultDispatcherUnregister();
      this.defaultDispatcherUnregister = null;
    }
    const unregister = this.subscribe((sessionId) => this.kickDispatch(sessionId, onDispatched));
    this.defaultDispatcherUnregister = () => {
      unregister();
      this.defaultDispatcherUnregister = null;
    };
    return this.defaultDispatcherUnregister;
  }

  /** Await every in-flight background dispatch. Called by app.shutdown(). */
  async drain(): Promise<void> {
    if (this.pendingDispatches.size === 0) return;
    await Promise.allSettled([...this.pendingDispatches]);
  }

  /**
   * Register an externally-managed background promise (e.g. SessionService's
   * `kickActionStage`) into the same pending set. `drain()` will await it
   * alongside the listener-owned dispatches; without this, a Promise spawned
   * outside the listener races shutdown unobserved.
   */
  track(promise: Promise<unknown>): void {
    this.pendingDispatches.add(promise);
    promise.finally(() => this.pendingDispatches.delete(promise)).catch(() => {});
  }

  private kickDispatch(sessionId: string, onDispatched: (session: Session | null) => void): void {
    const promise = this.dispatch(sessionId)
      .then(async (result) => {
        // dispatch returns `{ ok: false, message }` for non-throw failures
        // (e.g. "Stage 'pr' is create_pr, not agent" on an action stage).
        // Log the failure event AND flip the session to `failed` so the UI
        // stops showing it as pending/ready. Without the status update the
        // row renders "pending" forever despite the dispatch_failed event.
        if (result && result.ok === false) {
          const reason = result.message ?? "dispatch returned ok: false";
          await markDispatchFailedShared(this.sessions, this.events, sessionId, reason);
          return;
        }
        // Post-condition check on the success branch. dispatch() can legitimately
        // return `{ok:true}` without launching anything (action stage, hosted-mode
        // handoff, fan-out parent). For every OTHER ok:true case, a successful
        // launch flips the session out of `ready` -- typically to `running`.
        // If the row is still at `ready` AND the message isn't an explicit
        // "no-launch ok" sentinel, we hit a silent-launch-failure: surface it.
        if (result && result.ok === true) {
          const refreshed = await this.sessions.get(sessionId);
          if (refreshed && refreshed.status === "ready" && !messageAllowsNoLaunch(result.message)) {
            await markDispatchFailedShared(
              this.sessions,
              this.events,
              sessionId,
              `dispatch returned ok:true but session still at status=ready (message: ${result.message ?? "<no message>"})`,
            );
          }
        }
      })
      .catch(async (err) => {
        const reason = err instanceof Error ? err.message : String(err);
        await markDispatchFailedShared(this.sessions, this.events, sessionId, reason);
      })
      .then(async () => {
        onDispatched(await this.sessions.get(sessionId));
      });
    this.pendingDispatches.add(promise);
    promise
      .finally(() => this.pendingDispatches.delete(promise))
      .catch((err) => {
        logWarn("session", `SessionDispatchListeners: background dispatch chain threw (sessionId=${sessionId})`, {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}
