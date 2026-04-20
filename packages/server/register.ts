/**
 * RPC handler registration.
 *
 * Handlers come in two flavors:
 *
 * 1. **Shared** -- registered in both local and hosted mode. Their handler
 *    bodies never inspect a mode flag. (Shared handlers that query the
 *    knowledge graph, sessions, etc. work the same way under either mode.)
 *
 * 2. **Local-only** -- registered only when the app's `AppMode` exposes the
 *    corresponding capability. The capabilities (filesystem, knowledge
 *    index/export, mcp-by-dir, repo-map, fts-rebuild, host commands) are
 *    `null` in hosted `AppMode`, so `registerLocalOnlyHandlers` skips them
 *    without a runtime `if (hosted)` anywhere in a handler body.
 *
 * This is the ONLY place in the server package that branches on mode, and the
 * branch is over capability presence, not a boolean flag.
 */
import type { Router } from "./router.js";
import type { AppContext } from "../core/app.js";
import { ARK_VERSION } from "../protocol/types.js";
import { registerSessionHandlers } from "./handlers/session.js";
import { registerResourceHandlers } from "./handlers/resource.js";
import { registerMessagingHandlers } from "./handlers/messaging.js";
import { registerConfigHandlers } from "./handlers/config.js";
import { registerHistoryHandlers } from "./handlers/history.js";
import { registerHistoryLocalHandlers } from "./handlers/history-local.js";
import { registerToolsHandlers } from "./handlers/tools.js";
import { registerMetricsHandlers } from "./handlers/metrics.js";
import { registerMetricsLocalHandlers } from "./handlers/metrics-local.js";
import { registerMemoryHandlers } from "./handlers/memory.js";
import { registerScheduleHandlers } from "./handlers/schedule.js";
import { registerWebHandlers } from "./handlers/web.js";
import { registerWebLocalHandlers } from "./handlers/web-local.js";
import { registerKnowledgeHandlers } from "./handlers/knowledge.js";
import { registerKnowledgeLocalHandlers } from "./handlers/knowledge-local.js";
import { registerEvalHandlers } from "./handlers/eval.js";
import { registerDashboardHandlers } from "./handlers/dashboard.js";
import { registerFsHandlers } from "./handlers/fs.js";
import { registerTriggerHandlers } from "./handlers/triggers.js";
import { registerConnectorHandlers } from "./handlers/connectors.js";
import { registerIntegrationsHandlers } from "./handlers/integrations.js";

/**
 * Register every shared handler, then conditionally mount local-only handlers
 * based on the AppMode capabilities. Call sites should prefer this over
 * registering individual handler modules by hand.
 */
export function registerAllHandlers(router: Router, app: AppContext): void {
  router.handle("initialize", async (_params, _notify) => ({
    server: { name: "ark-server", version: ARK_VERSION },
    capabilities: { notifications: true, bidirectional: true },
  }));

  registerSharedHandlers(router, app);
  registerLocalOnlyHandlers(router, app);
}

/**
 * Shared handlers -- registered regardless of mode. Their bodies must not
 * inspect a mode flag; if a handler needs different behavior per mode, split
 * it into a shared core + local-only variant instead.
 */
export function registerSharedHandlers(router: Router, app: AppContext): void {
  registerSessionHandlers(router, app);
  registerResourceHandlers(router, app);
  registerMessagingHandlers(router, app);
  registerConfigHandlers(router, app);
  registerHistoryHandlers(router, app);
  registerToolsHandlers(router, app);
  registerMetricsHandlers(router, app);
  registerMemoryHandlers(router, app);
  registerScheduleHandlers(router, app);
  registerWebHandlers(router, app);
  registerKnowledgeHandlers(router, app);
  registerEvalHandlers(router, app);
  registerDashboardHandlers(router, app);
  registerTriggerHandlers(router, app);
  registerConnectorHandlers(router, app);
  registerIntegrationsHandlers(router, app);
}

/**
 * Local-only handlers. Each group is gated on the corresponding capability
 * being present; in hosted mode every capability is null and nothing here
 * registers. Callers doing custom wiring (tests) may invoke the individual
 * `register*LocalHandlers` functions directly.
 */
export function registerLocalOnlyHandlers(router: Router, app: AppContext): void {
  if (app.mode.fsCapability) {
    registerFsHandlers(router, app);
  }
  if (app.mode.ftsRebuildCapability) {
    registerHistoryLocalHandlers(router, app);
  }
  if (app.mode.knowledgeCapability && app.mode.mcpDirCapability && app.mode.repoMapCapability) {
    registerWebLocalHandlers(router, app);
  }
  if (app.mode.knowledgeCapability) {
    registerKnowledgeLocalHandlers(router, app);
  }
  if (app.mode.hostCommandCapability) {
    registerMetricsLocalHandlers(router, app);
  }
}
