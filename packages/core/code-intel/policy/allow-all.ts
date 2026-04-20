/**
 * AllowAllPolicy -- the Wave 1 stub that lets everything through.
 *
 * Real policy lands in D12 (control-plane row-level security + SQL guards).
 * Until then the surface is here so the rest of the code can depend on the
 * Policy interface unconditionally.
 */

import type { Policy, PolicyResult, PolicySubject } from "../interfaces/policy.js";
import type { QueryContext } from "../interfaces/query.js";

const ALLOW: PolicyResult = { allowed: true };

export class AllowAllPolicy implements Policy {
  allowRead(_ctx: QueryContext, _subject: PolicySubject): PolicyResult {
    return ALLOW;
  }
  allowWrite(_ctx: QueryContext, _subject: PolicySubject): PolicyResult {
    return ALLOW;
  }
  redact(_ctx: QueryContext, _subject: PolicySubject, row: Record<string, unknown>): Record<string, unknown> {
    return row;
  }
}
