/**
 * Hosted AppMode -- every filesystem / single-user capability is `null`.
 *
 * In hosted multi-tenant mode the server has no per-tenant filesystem view,
 * so every capability whose implementation would touch a local path or a
 * tenant-shared SQLite cache is explicitly absent. Handlers that depend on
 * these capabilities aren't registered at all (preferred) or refuse the call
 * with a consistent `RpcError` via the shared wrapper.
 */

import type {
  AppMode,
  ComputeBootstrapCapability,
  DatabaseMode,
  TenantResolverCapability,
  TenantScopeCapability,
} from "./app-mode.js";
import { resolveBearerAuth } from "./app-mode.js";
import { buildMigrationsCapability } from "./migrations-capability.js";
import { AwsSecretsProvider } from "../secrets/aws-provider.js";
import { FileSecretsProvider } from "../secrets/file-provider.js";
import type { SecretsCapability } from "../secrets/types.js";
import type { ArkConfig } from "../config.js";
import { buildTenantScope } from "../tenant-scope.js";

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
 * Hosted mode builds a tenant-scoped child DI container per call. Already-
 * scoped contexts (re-asked for the tenant they're already pinned to)
 * short-circuit to avoid nesting child scopes (which would invalidate
 * `===` identity checks on services across re-resolutions).
 */
function makeHostedTenantScope(): TenantScopeCapability {
  return {
    forTenant: (app, tenantId) => (app.tenantId === tenantId ? app : buildTenantScope(app, tenantId)),
  };
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

export function buildHostedAppMode(database: DatabaseMode, config?: ArkConfig): AppMode {
  const secretsCfg = config?.secrets;
  const secrets: SecretsCapability =
    secretsCfg?.backend === "file"
      ? new FileSecretsProvider(config?.dirs?.ark ?? `${process.env.HOME ?? "."}/.ark`)
      : new AwsSecretsProvider({ region: secretsCfg?.awsRegion, kmsKeyId: secretsCfg?.awsKmsKeyId });
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
    secrets,
    tenantResolver: makeHostedTenantResolver(),
    tenantScope: makeHostedTenantScope(),
    database,
    // Hosted mode has no default -- every session MUST carry an explicit
    // `compute_name`. A silent fall-through to "local" would mean agents
    // spawn inside the control-plane pod itself, competing with the
    // control plane for resources with zero isolation.
    defaultProvider: null,
  };
}
