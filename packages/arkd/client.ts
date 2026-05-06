/**
 * SHIM -- re-exports from client/ and common/. Will be deleted in Task 10.
 *
 * New code should import from:
 *   - client/client.js (ArkdClient)
 *   - common/errors.js (ArkdClientError, ArkdClientTransportError)
 */

export { ArkdClient } from "./client/client.js";
export { ArkdClientError, ArkdClientTransportError } from "./common/errors.js";
