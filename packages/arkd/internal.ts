/**
 * SHIM -- re-exports from new homes. Will be deleted in Task 10.
 *
 * New code should import from:
 *   - common/constants.js  (VERSION, DEFAULT_PORT, AUTH_EXEMPT_PATHS, SAFE_TMUX_NAME_RE)
 *   - common/validation.js (requireSafeTmuxName)
 *   - server/exec-allowlist.js (EXEC_ALLOWED_COMMANDS)
 *   - server/confinement.js (confineToWorkspace, PathConfinementError)
 *   - server/route-ctx.js (RouteCtx, ArkdOpts)
 *   - server/helpers.js (json, readStream, spawnRead, BunLike, BunSpawnProc)
 */

export {
  VERSION,
  DEFAULT_PORT,
  AUTH_EXEMPT_PATHS,
  SAFE_TMUX_NAME_RE,
} from "./common/constants.js";
export { requireSafeTmuxName } from "./common/validation.js";
export { EXEC_ALLOWED_COMMANDS } from "./server/exec-allowlist.js";
export { confineToWorkspace, PathConfinementError } from "./server/confinement.js";
export type { RouteCtx, ArkdOpts } from "./server/route-ctx.js";
export { json, readStream, spawnRead } from "./server/helpers.js";
export type { BunLike, BunSpawnProc } from "./server/helpers.js";
