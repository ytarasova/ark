/**
 * ArkD - universal agent daemon.
 *
 * Re-exports server, client, and types for use by compute providers.
 */

export { startArkd } from "./server.js";
export { ArkdClient, ArkdClientError } from "./client.js";
export type * from "./types.js";
