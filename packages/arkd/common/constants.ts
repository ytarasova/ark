/**
 * Wire-level constants. Imported by both arkd client and arkd server.
 *
 * SAFE_TMUX_NAME_RE doubles as the channel-name + process-handle pattern;
 * the name is a hold-over from when these primitives only wrapped tmux
 * sessions, but the regex is stable wire-protocol now.
 */

export const VERSION = "0.1.0";
export const DEFAULT_PORT = 19300;

/** Paths that bypass authentication (health probes). */
export const AUTH_EXEMPT_PATHS = new Set(["/health"]);

/**
 * tmux session names, channel names, and process handles must be usable
 * as both a shell argument and a POSIX filename component. The restricted
 * charset closes two injection surfaces:
 *
 *   1. The `/tmp/arkd-launcher-<sessionName>.sh` path -- without this
 *      guard, an attacker can write `../../../../etc/cron.d/poison` or
 *      clobber arbitrary files writable by the arkd user.
 *   2. The tmux shell-command argument `bash <scriptPath>` -- tmux
 *      parses the final argv as a shell command, so spaces /
 *      metacharacters in the session name bleed into shell parsing.
 */
export const SAFE_TMUX_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Wire control frame the server sends as the very first message on every
 * new subscriber WS, after the subscriber is registered and the ring
 * buffer has been drained. The client iterator strips this frame before
 * yielding to callers.
 *
 * Pre-stringified at module load so the server's hot-path doesn't
 * JSON.stringify on every connect.
 */
export const SUBSCRIBED_ACK = JSON.stringify({ type: "subscribed" });
