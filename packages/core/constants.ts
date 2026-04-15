/**
 * Shared constants for default URLs and ports.
 *
 * Eliminates hardcoded "http://localhost:19100" scattered across providers,
 * executors, and the conductor. Each constant reads from the environment
 * first, falling back to the documented default.
 */

/** Default conductor URL (env: ARK_CONDUCTOR_URL) */
export const DEFAULT_CONDUCTOR_URL = process.env.ARK_CONDUCTOR_URL || "http://localhost:19100";

/** Default conductor host / bind address (env: ARK_CONDUCTOR_HOST) */
export const DEFAULT_CONDUCTOR_HOST = process.env.ARK_CONDUCTOR_HOST || "0.0.0.0";

/** Default conductor port (env: ARK_CONDUCTOR_PORT) */
export const DEFAULT_CONDUCTOR_PORT = parseInt(process.env.ARK_CONDUCTOR_PORT ?? "19100", 10);

/** Default arkd URL (env: ARK_ARKD_URL) */
export const DEFAULT_ARKD_URL = process.env.ARK_ARKD_URL || "http://localhost:19300";

/** Default arkd port (env: ARK_ARKD_PORT) */
export const DEFAULT_ARKD_PORT = parseInt(process.env.ARK_ARKD_PORT ?? "19300", 10);

/** Base URL for channel HTTP servers (env: ARK_CHANNEL_BASE_URL) */
export const DEFAULT_CHANNEL_BASE_URL = process.env.ARK_CHANNEL_BASE_URL || "http://localhost";

/** Default LLM router URL (env: ARK_ROUTER_URL) */
export const DEFAULT_ROUTER_URL = process.env.ARK_ROUTER_URL || "http://localhost:8430";

/** Default Ark server port for the daemon/WebSocket server (env: ARK_SERVER_PORT) */
export const DEFAULT_SERVER_PORT = parseInt(process.env.ARK_SERVER_PORT ?? "19400", 10);

/** Default Ark server URL (env: ARK_SERVER_URL) */
export const DEFAULT_SERVER_URL = process.env.ARK_SERVER_URL || `http://localhost:${DEFAULT_SERVER_PORT}`;

/** Docker host conductor URL (for devcontainer/docker dispatch) */
export const DOCKER_CONDUCTOR_URL = "http://host.docker.internal:19100";

// Note: the old `CHANNEL_SCRIPT_PATH` constant was removed -- it computed a
// filesystem path from `import.meta.dir` which resolves into Bun's virtual
// FS in compiled binaries and cannot be passed to a subprocess. Callers
// should use `channelLaunchSpec()` from `./install-paths.js` to get the
// correct command + args for launching the channel MCP server.
