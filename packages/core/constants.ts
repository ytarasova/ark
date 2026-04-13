/**
 * Shared constants for default URLs and ports.
 *
 * Eliminates hardcoded "http://localhost:19100" scattered across providers,
 * executors, and the conductor. Each constant reads from the environment
 * first, falling back to the documented default.
 */

import { join } from "path";

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

/** Docker host conductor URL (for devcontainer/docker dispatch) */
export const DOCKER_CONDUCTOR_URL = "http://host.docker.internal:19100";

/** Default daemon WebSocket port (env: ARK_DAEMON_WS_PORT) */
export const DEFAULT_DAEMON_WS_PORT = parseInt(process.env.ARK_DAEMON_WS_PORT ?? "19400", 10);

/** Lockfile name written to arkDir when the daemon is running. */
export const DAEMON_LOCKFILE_NAME = "daemon.json";

/** Absolute path to the channel MCP server script (packages/core/conductor/channel.ts). */
export const CHANNEL_SCRIPT_PATH = join(import.meta.dir, "conductor", "channel.ts");
