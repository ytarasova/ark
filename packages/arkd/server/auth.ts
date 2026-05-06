/**
 * Auth helpers for the arkd HTTP server.
 *
 * Handles token persistence and constant-time bearer token verification.
 * Extracted from server.ts to keep server.ts focused on Bun.serve wiring.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { timingSafeEqual } from "crypto";
import { AUTH_EXEMPT_PATHS } from "../common/constants.js";
import { json } from "./helpers.js";

/**
 * Persist the arkd auth token to ~/.ark/arkd.token (mode 0600) so that
 * CLI tools can pick it up without re-reading the process env. Returns the
 * pre-computed `Bearer <token>` byte buffer used by checkAuth, or null when
 * no token is configured.
 */
export function setupAuth(token: string | null): Buffer | null {
  if (token) {
    const arkDir = join(homedir(), ".ark");
    if (!existsSync(arkDir)) mkdirSync(arkDir, { recursive: true });
    writeFileSync(join(arkDir, "arkd.token"), token, { mode: 0o600 });
  }

  // Pre-compute the expected header bytes so the timing-safe comparison
  // sees a fixed-length reference. timingSafeEqual throws on length mismatch,
  // so we pre-pad the provided header to the expected length before compare
  // and still return 401 -- this collapses "unauthorized" and "wrong length"
  // into a single timing path, removing the obvious side channel.
  return token ? Buffer.from(`Bearer ${token}`) : null;
}

/**
 * Constant-time bearer token check. Returns a 401 Response when auth fails,
 * or null to allow the request through.
 *
 * Bypasses AUTH_EXEMPT_PATHS (/health). Supports Sec-WebSocket-Protocol
 * Bearer.<token> as an alternative transport for WebSocket upgrades.
 */
export function checkAuth(req: Request, path: string, expectedAuth: Buffer | null): Response | null {
  if (!expectedAuth) return null;
  if (AUTH_EXEMPT_PATHS.has(path)) return null;
  let authHeader = req.headers.get("Authorization") ?? "";
  // WebSocket upgrade requests can't easily set custom headers from
  // browsers; allow the bearer token to ride in the
  // Sec-WebSocket-Protocol subprotocol header as `Bearer.<token>`.
  // This matches what `ArkdClient.subscribeToChannel` sends. The
  // value is still constant-time-compared below; subprotocol is
  // just a transport for the same token.
  if (!authHeader) {
    const subproto = req.headers.get("Sec-WebSocket-Protocol") ?? "";
    const m = subproto
      .split(",")
      .map((s) => s.trim())
      .find((s) => s.startsWith("Bearer."));
    if (m) authHeader = `Bearer ${m.slice("Bearer.".length)}`;
  }
  const providedBuf = Buffer.from(authHeader);
  // Mismatched length => definitely wrong; still run a constant-time compare
  // against a fixed-size dummy so the timing does not leak "wrong length".
  if (providedBuf.length !== expectedAuth.length) {
    timingSafeEqual(expectedAuth, expectedAuth);
    return json({ error: "Unauthorized" }, 401);
  }
  if (timingSafeEqual(providedBuf, expectedAuth)) return null;
  return json({ error: "Unauthorized" }, 401);
}
