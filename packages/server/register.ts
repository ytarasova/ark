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
import { registerToolsHandlers } from "./handlers/tools.js";
import { registerMetricsHandlers } from "./handlers/metrics.js";
import { registerMetricsLocalHandlers } from "./handlers/metrics-local.js";
import { registerScheduleHandlers } from "./handlers/schedule.js";
import { registerWebHandlers } from "./handlers/web.js";
import { registerDashboardHandlers } from "./handlers/dashboard.js";
import { registerFsHandlers } from "./handlers/fs.js";
import { registerTriggerHandlers } from "./handlers/triggers.js";
import { registerConnectorHandlers } from "./handlers/connectors.js";
import { registerIntegrationsHandlers } from "./handlers/integrations.js";
import { registerSecretsHandlers } from "./handlers/secrets.js";
import { registerAdminHandlers } from "./handlers/admin.js";
// --- BEGIN agent-B: admin-policy + admin-apikey ---
import { registerAdminPolicyHandlers } from "./handlers/admin-policy.js";
import { registerAdminApiKeyHandlers } from "./handlers/admin-apikey.js";
// --- END agent-B ---
// --- BEGIN agent-C: resource-crud ---
import { registerResourceCrudHandlers } from "./handlers/resource-crud.js";
// --- END agent-C ---
// --- BEGIN agent-E: conductor + costs ---
import { registerConductorHandlers } from "./handlers/conductor.js";
import { registerCostsAdminHandlers } from "./handlers/costs.js";
// --- END agent-E ---
// --- BEGIN agent-F: tenant-auth ---
import { registerTenantAuthHandlers } from "./handlers/tenant-auth.js";
// --- END agent-F ---
// --- BEGIN agent-G: clusters + tenant compute config ---
import { registerClusterHandlers } from "./handlers/clusters.js";
// --- END agent-G ---

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
  registerToolsHandlers(router, app);
  registerMetricsHandlers(router, app);
  registerScheduleHandlers(router, app);
  registerWebHandlers(router, app);
  registerDashboardHandlers(router, app);
  registerTriggerHandlers(router, app);
  registerConnectorHandlers(router, app);
  registerIntegrationsHandlers(router, app);
  registerSecretsHandlers(router, app);
  registerAdminHandlers(router, app);

  // --- BEGIN agent-B: admin-policy + admin-apikey ---
  registerAdminPolicyHandlers(router, app);
  registerAdminApiKeyHandlers(router, app);
  // --- END agent-B ---

  // --- BEGIN agent-C: resource-crud ---
  // Must run AFTER registerResourceHandlers so the YAML-aware variants win
  // for agent/create, agent/delete, skill/delete, recipe/delete. The new
  // handlers still accept the legacy structured shape for back-compat.
  registerResourceCrudHandlers(router, app);
  // --- END agent-C ---

  // --- BEGIN agent-E: conductor + costs ---
  registerConductorHandlers(router, app);
  registerCostsAdminHandlers(router, app);
  // --- END agent-E ---

  // --- BEGIN agent-F: tenant-auth ---
  registerTenantAuthHandlers(router, app);
  // --- END agent-F ---

  // --- BEGIN agent-G: clusters + tenant compute config ---
  registerClusterHandlers(router, app);
  // --- END agent-G ---
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
  if (app.mode.hostCommandCapability) {
    registerMetricsLocalHandlers(router, app);
  }
}
