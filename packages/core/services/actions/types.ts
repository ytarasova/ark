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

export interface ActionHandler {
  /** Stable action key matching the flow YAML `action:` value. */
  readonly name: string;
  /** Optional aliases (e.g. `merge` is an alias of `merge_pr`). */
  readonly aliases?: readonly string[];
  /**
   * Execute the action. The handler is responsible for its own event logging
   * on success -- `executeAction` only handles the "unknown action" case.
   */
  execute(app: AppContext, session: Session, action: string): Promise<ActionResult>;
}
