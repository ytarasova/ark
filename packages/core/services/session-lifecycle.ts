/**
 * DEPRECATED -- back-compat barrel for the legacy free-function API.
 *
 * The real implementation now lives in `packages/core/services/session/`
 * as the `SessionLifecycle` class, registered in the DI container and
 * surfaced on `AppContext` as `app.sessionLifecycle`. New code MUST use
 * the class via `app.sessionLifecycle.X`; this file exists only to keep
 * existing callers (30-ish files + tests) from churning in a single PR.
 *
 * Every wrapper here simply delegates to `app.sessionLifecycle.X`.
 */

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import type {
  LifecycleHooks,
  SessionOpResult,
  StartSessionOpts,
  VerificationResult,
  VerifyScriptRunner,
} from "./session/types.js";

export type { LifecycleHooks, SessionOpResult, VerificationResult, VerifyScriptRunner } from "./session/types.js";
export { renderReworkPrompt, resolveGitHubUrl } from "./session/index.js";

export function startSession(app: AppContext, opts: StartSessionOpts, hooks?: LifecycleHooks): Promise<Session> {
  return app.sessionLifecycle.start(opts, hooks);
}

export function recordSessionUsage(
  app: AppContext,
  session: Session,
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number },
  provider: string,
  source: string,
): void {
  app.sessionLifecycle.recordSessionUsage(session, usage, provider, source);
}

export function stop(
  app: AppContext,
  sessionId: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; message: string }> {
  return app.sessionLifecycle.stop(sessionId, opts);
}

export function runVerification(
  app: AppContext,
  sessionId: string,
  opts?: { runScript?: VerifyScriptRunner; timeoutMs?: number },
): Promise<VerificationResult> {
  return app.sessionLifecycle.runVerification(sessionId, opts);
}

export function pause(
  app: AppContext,
  sessionId: string,
  reason?: string,
): Promise<{ ok: boolean; message: string }> {
  return app.sessionLifecycle.pause(sessionId, reason);
}

export function archive(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  return app.sessionLifecycle.archive(sessionId);
}

export function restore(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  return app.sessionLifecycle.restore(sessionId);
}

export function interrupt(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  return app.sessionLifecycle.interrupt(sessionId);
}

/**
 * Approve a review gate. `advanceFn` (if supplied) is threaded through so
 * tests can substitute a stub; production callers omit it and get the
 * DI-wired `advance` callback.
 */
export function approveReviewGate(
  app: AppContext,
  sessionId: string,
  advanceFn?: (app: AppContext, sessionId: string, force?: boolean) => Promise<{ ok: boolean; message: string }>,
): Promise<{ ok: boolean; message: string }> {
  const override = advanceFn ? (id: string, force?: boolean) => advanceFn(app, id, force) : undefined;
  return app.sessionLifecycle.approveReviewGate(sessionId, override);
}

/** Reject a review gate. `dispatchFn` (if supplied) is threaded through. */
export function rejectReviewGate(
  app: AppContext,
  sessionId: string,
  reason: string,
  dispatchFn?: (app: AppContext, sessionId: string) => Promise<{ ok: boolean; message: string }>,
): Promise<{ ok: boolean; message: string }> {
  const override = dispatchFn ? (id: string) => dispatchFn(app, id) : undefined;
  return app.sessionLifecycle.rejectReviewGate(sessionId, reason, override);
}

export function forkSession(
  app: AppContext,
  sessionId: string,
  newName?: string,
  hooks?: LifecycleHooks,
): Promise<SessionOpResult> {
  return app.sessionLifecycle.fork(sessionId, newName, hooks);
}

export function cloneSession(
  app: AppContext,
  sessionId: string,
  newName?: string,
  hooks?: LifecycleHooks,
): Promise<SessionOpResult> {
  return app.sessionLifecycle.clone(sessionId, newName, hooks);
}

export function deleteSessionAsync(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  return app.sessionLifecycle.deleteSession(sessionId);
}

export function undeleteSessionAsync(
  app: AppContext,
  sessionId: string,
): Promise<{ ok: boolean; message: string }> {
  return app.sessionLifecycle.undeleteSession(sessionId);
}

export function cleanupOnTerminal(app: AppContext, sessionId: string): Promise<void> {
  return app.sessionLifecycle.cleanupOnTerminal(sessionId);
}

export function waitForCompletion(
  app: AppContext,
  sessionId: string,
  opts?: { timeoutMs?: number; pollMs?: number; onStatus?: (status: string) => void },
): Promise<{ session: Session | null; timedOut: boolean }> {
  return app.sessionLifecycle.waitForCompletion(sessionId, opts);
}
