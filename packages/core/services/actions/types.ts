/**
 * Action handler registry for non-agent stages (create_pr, merge, close, ...).
 *
 * Each handler is a self-contained module. `executeAction` consults the
 * registry below; adding a new action means creating a new file and
 * registering it here -- no switch to edit.
 *
 * Design mirrors `packages/compute/flag-specs/` (the ProviderFlagSpec
 * registry). Action-layer adapters are NOT part of the core Compute/Runtime
 * interfaces; they operate on an AppContext + Session.
 */

import type { AppContext } from "../../app.js";
import type { Session } from "../../../types/index.js";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Optional per-call options passed to action handlers. Today the only field
 * is `idempotencyKey` (RF-8 / #388) -- set by callers that want at-most-once
 * semantics under at-least-once activity retries (Temporal). Omit to preserve
 * today's behavior exactly.
 */
export interface ActionOpts {
  idempotencyKey?: string;
}

export interface ActionHandler {
  /** Stable action key matching the flow YAML `action:` value. */
  readonly name: string;
  /** Optional aliases (e.g. `merge` is an alias of `merge_pr`). */
  readonly aliases?: readonly string[];
  /**
   * Run the action. The handler is responsible for its own event logging
   * on success -- `executeAction` only handles the "unknown action" case.
   *
   * `opts.idempotencyKey` is threaded through by the executeAction dispatcher
   * so individual handlers don't need to care about the ledger -- the dispatch
   * wrapper deduplicates. Handlers may still inspect opts if they need
   * per-action keys for internal sub-operations.
   */
  execute(app: AppContext, session: Session, action: string, opts?: ActionOpts): Promise<ActionResult>;
}
