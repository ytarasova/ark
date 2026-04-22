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
import { advance as _advance } from "./stage-advance.js";
import { dispatch as _dispatch } from "./dispatch.js";

export async function approveReviewGate(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  return app.sessionLifecycle.approveReviewGate(sessionId, (id, force) => _advance(app, id, force));
}

export async function rejectReviewGate(
  app: AppContext,
  sessionId: string,
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  return app.sessionLifecycle.rejectReviewGate(sessionId, reason, (id) => _dispatch(app, id));
}
