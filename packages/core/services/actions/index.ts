/**
 * Action registry. Each action handler lives in its own file; `executeAction`
 * consults this registry to dispatch. To add a new action, create a new file
 * exporting an `ActionHandler` and add it to `ACTIONS` below.
 */

import type { ActionHandler, ActionOpts, ActionResult } from "./types.js";
import { createPrAction } from "./create-pr.js";
import { mergePrAction } from "./merge-pr.js";
import { autoMergeAction } from "./auto-merge.js";
import { closeAction } from "./close.js";
import type { AppContext } from "../../app.js";
import { withIdempotency } from "../idempotency.js";

export type { ActionHandler, ActionOpts, ActionResult } from "./types.js";

const ACTIONS: readonly ActionHandler[] = [createPrAction, mergePrAction, autoMergeAction, closeAction];

const ACTION_INDEX: Map<string, ActionHandler> = (() => {
  const m = new Map<string, ActionHandler>();
  for (const a of ACTIONS) {
    m.set(a.name, a);
    for (const alias of a.aliases ?? []) m.set(alias, a);
  }
  return m;
})();

/** Resolve an action name (or alias) to its handler. */
export function getAction(name: string): ActionHandler | undefined {
  return ACTION_INDEX.get(name);
}

/** List every registered action name (canonical names only, no aliases). */
export function listActions(): string[] {
  return ACTIONS.map((a) => a.name);
}

/**
 * Dispatch the named action for `sessionId`. Returns a result with the
 * standard `{ok, message}` shape. Unknown actions log a `action_skipped`
 * event and return `ok: true` to preserve the prior switch's behaviour.
 *
 * When `opts.idempotencyKey` is set, the dispatch is keyed in
 * `stage_operations` under `op_kind = "action:<name>"` so at-least-once
 * retries (Temporal) no-op and return the cached result. Action handlers
 * themselves stay single-purpose -- the wrapper owns the ledger.
 */
export async function executeAction(
  app: AppContext,
  sessionId: string,
  action: string,
  opts?: ActionOpts,
): Promise<ActionResult> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: "Session not found" };

  const handler = ACTION_INDEX.get(action);
  if (!handler) {
    // Unknown actions short-circuit before the ledger so every retry still
    // logs `action_skipped` with the same payload (cheap, helps debugging).
    await app.events.log(sessionId, "action_skipped", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: { action, reason: "unknown action type" },
    });
    return { ok: true, message: `Action '${action}' skipped (unknown)` };
  }

  // Key on the canonical action name so aliases don't create two ledger
  // rows for the same logical operation.
  const opKind = `action:${handler.name}` as const;
  return withIdempotency(
    app.db,
    { sessionId, stage: session.stage ?? null, opKind, idempotencyKey: opts?.idempotencyKey },
    () => handler.execute(app, session, action, opts),
  );
}
