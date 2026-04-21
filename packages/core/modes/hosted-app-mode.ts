/**
 * Hosted AppMode -- every filesystem / single-user capability is `null`.
 *
 * In hosted multi-tenant mode the server has no per-tenant filesystem view,
 * so every capability whose implementation would touch a local path or a
 * tenant-shared SQLite cache is explicitly absent. Handlers that depend on
 * these capabilities aren't registered at all (preferred) or refuse the call
 * with a consistent `RpcError` via the shared wrapper.
 */

import type { AppMode, ComputeBootstrapCapability, DatabaseMode, TenantResolverCapability } from "./app-mode.js";
import { resolveBearerAuth } from "./app-mode.js";
import { buildMigrationsCapability } from "./migrations-capability.js";

/**
 * Hosted compute bootstrap is intentionally a no-op. The operator
 * registers real compute targets (k8s / docker / ec2 / firecracker) post-
 * onboarding via `ark compute add`. We never silently seed a `local` row
 * because "local" inside a control-plane pod means agents would spawn in
 * the control-plane container itself -- no isolation, competes with the
 * control plane for resources.
 */
function makeNoopComputeBootstrap(): ComputeBootstrapCapability {
  return { seed: async () => undefined };
}

/**
 * Hosted multi-tenant resolver.
 *
 *   - Authorization: Bearer <token>  -> validate + use its tenant (shared path)
 *   - Only X-Ark-Tenant-Id            -> 401. In a multi-tenant server the
 *                                        tenant header cannot be self-declared;
 *                                        it must match a validated Bearer
 *                                        token. Closes the cross-tenant
 *                                        exposure vector flagged in the P1
 *                                        security audit.
 *   - No headers                      -> 401 (authentication required).
 */
function makeHostedTenantResolver(): TenantResolverCapability {
  return {
    async resolve({ authHeader, tenantHeader, validateToken }) {
      if (authHeader) return resolveBearerAuth(authHeader, tenantHeader, validateToken);
      if (tenantHeader) {
        return {
          ok: false,
          status: 401,
          error: "X-Ark-Tenant-Id requires a validated Authorization: Bearer token",
        };
      }
      return { ok: false, status: 401, error: "authentication required" };
    },
  };
}

export function buildHostedAppMode(database: DatabaseMode): AppMode {
  return {
    kind: "hosted",
    fsCapability: null,
    knowledgeCapability: null,
    mcpDirCapability: null,
    repoMapCapability: null,
    ftsRebuildCapability: null,
    hostCommandCapability: null,
    computeBootstrap: makeNoopComputeBootstrap(),
    migrations: buildMigrationsCapability("postgres"),
    tenantResolver: makeHostedTenantResolver(),
    database,
  };
}
