/**
 * Public surface for arkd client. The error classes live in common/ but
 * are re-exported here for ergonomics -- existing call sites do
 * `import { ArkdClient, ArkdClientError } from "..."` in one go.
 */

export { ArkdClient } from "./client.js";
export { ArkdClientError, ArkdClientTransportError } from "../common/errors.js";
