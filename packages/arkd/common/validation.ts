/**
 * Wire validators shared by arkd client + arkd server.
 *
 * Both sides validate so the client can fail fast (saving a round trip)
 * and the server enforces regardless of caller (security).
 */

import { SAFE_TMUX_NAME_RE } from "./constants.js";

/**
 * Assert a value is a string matching the safe-name pattern. Used for
 * tmux session names, channel names, and process handles -- everything
 * that ends up as a shell argument or a filename component.
 */
export function requireSafeTmuxName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !SAFE_TMUX_NAME_RE.test(name)) {
    throw new Error("invalid sessionName: must match [A-Za-z0-9_-]{1,64}");
  }
}
