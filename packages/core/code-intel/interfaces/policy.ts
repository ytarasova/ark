/**
 * Policy -- per-tenant read/write/redact gates layered on top of the store.
 *
 * Wave 1 ships an allow-all stub at `policy/allow-all.ts`. D12 replaces it
 * with a real implementation backed by Postgres RLS (control-plane) or a
 * SQL parser guard (local). Code outside the policy module should depend
 * only on this interface.
 *
 * Example:
 *   const deny: Policy = {
 *     allowRead: () => ({ allowed: false, reason: "tenant quarantine" }),
 *     allowWrite: () => ({ allowed: false, reason: "read-only tenant" }),
 *     redact: (_ctx, _s, row) => ({ ...row, secret: "***" }),
 *   };
 */

import type { QueryContext } from "./query.js";
import type { SubjectKind } from "./types.js";

export interface PolicySubject {
  kind: SubjectKind;
  id?: string;
  path?: string;
  name?: string;
}

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

export interface Policy {
  allowRead(ctx: QueryContext, subject: PolicySubject): PolicyResult;
  allowWrite(ctx: QueryContext, subject: PolicySubject): PolicyResult;
  redact(ctx: QueryContext, subject: PolicySubject, row: Record<string, unknown>): Record<string, unknown>;
}
