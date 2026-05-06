/**
 * Public surface for arkd server. The CLI subcommand (`ark arkd`) and
 * the in-process launcher (`core/infra/arkd-launcher.ts`) both import
 * `startArkd` from here.
 */

export { startArkd, PathConfinementError, VERSION } from "./server.js";
export type { ArkdOpts } from "./server.js";
