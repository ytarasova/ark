/**
 * Migration 013 -- previously retagged eval knowledge nodes to type='eval_session'.
 *
 * Now a no-op marker. The knowledge graph (and the underlying `knowledge`
 * table) was removed when code-intel/knowledge were dropped. The migration
 * row stays in the apply-log for installs that already applied 013 against
 * a live knowledge table.
 */

import type { MigrationApplyContext } from "./types.js";

export const VERSION = 13;
export const NAME = "eval_session_type";

export async function up(_ctx: MigrationApplyContext): Promise<void> {
  // intentionally empty -- knowledge table no longer exists
  return;
}
