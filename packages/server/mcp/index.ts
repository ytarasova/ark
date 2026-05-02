/**
 * Ark MCP server module -- entry point.
 *
 * Re-exports `handleMcpRequest` (called from the daemon's HTTP fetch handler)
 * and `sharedRegistry` (used by tools/* modules to register themselves).
 *
 * As more tool groups are added, append `import "./tools/<group>.js"` here so
 * their side-effect register runs on module load.
 */

import "./tools/session.js"; // side-effect register
import "./tools/flow.js"; // side-effect register

export { handleMcpRequest, sharedRegistry } from "./transport.js";
export type { ToolDef, ToolHandlerCtx } from "./registry.js";
