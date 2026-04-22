/**
 * Review-gate wrappers -- inject `advance` / `dispatch` deps into the
 * `approveReviewGate` / `rejectReviewGate` primitives on
 * `app.sessionLifecycle`.
 *
 * The SessionLifecycle class exposes gate primitives that accept an
 * `advance` / `dispatch` override so the service layer (and tests) can
 * substitute their own; the production wrappers here thread in the real
 * module-level `advance` and `dispatch` functions.
 */

import type { AppContext } from "../app.js";

export async function approveReviewGate(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  return app.sessionLifecycle.approveReviewGate(sessionId, (id, force) => app.stageAdvance.advance(id, force));
}

export async function rejectReviewGate(
  app: AppContext,
  sessionId: string,
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  return app.sessionLifecycle.rejectReviewGate(sessionId, reason, (id) => app.dispatchService.dispatch(id));
}
