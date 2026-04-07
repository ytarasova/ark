/**
 * Shared constants for default URLs and ports.
 *
 * Eliminates hardcoded "http://localhost:19100" scattered across providers,
 * executors, and the conductor. Each constant reads from the environment
 * first, falling back to the documented default.
 */

/** Default conductor URL (env: ARK_CONDUCTOR_URL) */
export const DEFAULT_CONDUCTOR_URL = process.env.ARK_CONDUCTOR_URL ?? "http://localhost:19100";

/** Default conductor port (env: ARK_CONDUCTOR_PORT) */
export const DEFAULT_CONDUCTOR_PORT = parseInt(process.env.ARK_CONDUCTOR_PORT ?? "19100", 10);

/** Default arkd URL (env: ARK_ARKD_URL) */
export const DEFAULT_ARKD_URL = process.env.ARK_ARKD_URL ?? "http://localhost:19300";

/** Default arkd port (env: ARK_ARKD_PORT) */
export const DEFAULT_ARKD_PORT = parseInt(process.env.ARK_ARKD_PORT ?? "19300", 10);

/** Docker host conductor URL (for devcontainer/docker dispatch) */
export const DOCKER_CONDUCTOR_URL = "http://host.docker.internal:19100";
