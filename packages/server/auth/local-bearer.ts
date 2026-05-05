/**
 * Process-local bearer for the `/mcp` route in local profile.
 *
 * The arkd daemon writes a fresh token to `<arkDir>/arkd.token` on every
 * first boot (see `packages/arkd/server.ts`). The same token is the bearer
 * the MCP route checks in local mode -- any caller that can read
 * `~/.ark/arkd.token` (i.e. the process owner) is allowed; anyone else is
 * rejected with 401.
 *
 * Kept out of `packages/core/auth/context.ts` on purpose: that module is
 * deliberately dependency-light (no fs, no crypto) and `TenantContext`
 * plumbing is a separate concern from this local-secret gate.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { timingSafeEqual } from "crypto";

/**
 * Read the local arkd.token file. Returns `null` for any condition that
 * should skip the gate: no arkDir, file missing, unreadable, or empty.
 * Callers MUST treat `null` as "no gate" (grandfather fresh installs that
 * have not booted arkd yet).
 */
export function readLocalBearer(arkDir: string | null | undefined): string | null {
  if (!arkDir) return null;
  const path = join(arkDir, "arkd.token");
  if (!existsSync(path)) return null;
  try {
    const value = readFileSync(path, "utf-8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time bearer compare. Length-mismatch short-circuits (no early
 * return leaking byte positions), but we still run a dummy timingSafeEqual
 * so the happy and sad paths have the same latency profile -- the same
 * shape arkd and the web proxy use.
 */
export function matchesLocalBearer(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}
