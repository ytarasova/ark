/**
 * SHIM -- re-exports from server/server.ts. Will be deleted in Task 10.
 *
 * New code should import from `./server/server.js` (or
 * `arkd/server/index.js` once Task 7 lands).
 */

export { startArkd, PathConfinementError, VERSION } from "./server/server.js";
export type { ArkdOpts } from "./server/server.js";
