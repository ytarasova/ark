/**
 * Hosted AppMode -- every filesystem / single-user capability is `null`.
 *
 * In hosted multi-tenant mode the server has no per-tenant filesystem view,
 * so every capability whose implementation would touch a local path or a
 * tenant-shared SQLite cache is explicitly absent. Handlers that depend on
 * these capabilities aren't registered at all (preferred) or refuse the call
 * with a consistent `RpcError` via the shared wrapper.
 */

import type { AppMode } from "./app-mode.js";

export function buildHostedAppMode(): AppMode {
  return {
    kind: "hosted",
    fsCapability: null,
    knowledgeCapability: null,
    mcpDirCapability: null,
    repoMapCapability: null,
    ftsRebuildCapability: null,
    hostCommandCapability: null,
  };
}
