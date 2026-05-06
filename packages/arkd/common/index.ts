/**
 * Public surface for arkd common (wire types + constants + shared
 * validators + error classes). Imported by both client + server
 * consumers.
 */

export type * from "./types.js";
export { VERSION, DEFAULT_PORT, AUTH_EXEMPT_PATHS, SAFE_TMUX_NAME_RE, SUBSCRIBED_ACK } from "./constants.js";
export { requireSafeTmuxName } from "./validation.js";
export { ArkdClientError, ArkdClientTransportError } from "./errors.js";
