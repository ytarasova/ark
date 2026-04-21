/**
 * CLI ArkClient facade.
 *
 * Legacy call sites imported `getArkClient` / `setLocalApp` / `setRemoteServer`
 * directly from this module; the transport and auto-spawn logic now live in
 * `./app-client.ts`. This file remains as a thin re-export so existing
 * imports keep working.
 */

export { getArkClient, setRemoteServer, isRemoteMode, setServerPort, closeArkClient } from "./app-client.js";

/**
 * Back-compat shim: the old `setLocalApp(app)` entry point is retired.
 * Local mode now connects to a daemon (auto-spawned when needed) instead
 * of running the server in-process. Commands that still need direct
 * `AppContext` access use `getInProcessApp()` from `app-client.ts`.
 *
 * Kept as a no-op so callers that still wire it up don't crash.
 */
export function setLocalApp(_app: unknown): void {
  // no-op -- retained for source compatibility
}
