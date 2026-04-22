/**
 * Review-gate wrappers -- inject `advance` / `dispatch` deps into the
 * `approveReviewGate` / `rejectReviewGate` primitives that live in
 * `session-lifecycle.ts`.
 *
 * Extracted from the old `session-orchestration.ts` barrel so callers (and
 * `SessionService`) can depend on this tiny module instead of the barrel.
 */

import type { AppContext } from "../app.js";
import { approveReviewGate as _approveReviewGate, rejectReviewGate as _rejectReviewGate } from "./session-lifecycle.js";
import { advance as _advance } from "./stage-advance.js";
import { dispatch as _dispatch } from "./dispatch.js";

export async function approveReviewGate(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  return _approveReviewGate(app, sessionId, _advance);
}

export async function rejectReviewGate(
  app: AppContext,
  sessionId: string,
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  return _rejectReviewGate(app, sessionId, reason, _dispatch);
}
