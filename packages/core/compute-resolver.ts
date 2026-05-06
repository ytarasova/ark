/**
 * Compute / Isolation resolution helpers.
 *
 * Extracted from app.ts so AppContext stays focused on lifecycle. Both
 * helpers are pure functions over an AppContext + session.
 *
 * Security: compute lookup MUST go through `app.computes.get()` (the
 * tenant-scoped `ComputeRepository`), never a raw `db.prepare(...)`.
 * The compute table's primary key is `(name, tenant_id)`; using a raw
 * SELECT without a tenant filter lets any tenant resolve another
 * tenant's provider/credentials for a colliding compute name (e.g.
 * `prod-gpu`, `ci-runner`). Callers are expected to pass in a
 * tenant-scoped AppContext (`app.forTenant(session.tenant_id)`);
 * `ComputeRepository.get` enforces `WHERE tenant_id = ?`.
 */
import type { AppContext } from "./app.js";
import type { Session, Compute, ComputeProviderName } from "../types/index.js";
import type { ComputeProvider } from "./compute/legacy-provider.js";
import type { ComputeKind, IsolationKind } from "./compute/types.js";

export async function resolveProvider(
  app: AppContext,
  session: Session,
): Promise<{ provider: ComputeProvider | null; compute: Compute | null }> {
  // When a session has no explicit `compute_name` we fall back to the
  // AppMode's default provider (local mode: "local"; hosted mode: null).
  // Hosted mode returns `{ provider: null, compute: null }` on purpose --
  // callers that need a provider must surface a clear error rather than
  // silently dispatching the session onto the control-plane host.
  const defaultName = app.mode.defaultProvider;
  const computeName = session.compute_name || defaultName;
  if (!computeName) return { provider: null, compute: null };
  // Re-scope to the session's tenant when the caller passed a different (or
  // unscoped root) AppContext. Compute PK is (name, tenant_id) -- without this
  // re-scope, two tenants holding the same compute name get arbitrary row-order
  // resolution and can leak each other's provider + credentials.
  const scoped = session.tenant_id && session.tenant_id !== app.tenantId ? app.forTenant(session.tenant_id) : app;
  const compute = await scoped.computes.get(computeName);
  if (!compute) return { provider: null, compute: null };
  // Derive the legacy provider key from the two-axis (compute_kind, isolation_kind)
  // since the `provider` field has been removed from the Compute type.
  // ProviderRegistry is still keyed by legacy provider names.
  const { pairToProvider } = await import("./compute/adapters/provider-map.js");
  const providerKey =
    pairToProvider({ compute: compute.compute_kind, isolation: compute.isolation_kind }) ??
    (compute.compute_kind as string);
  const provider = app.getProvider(providerKey as ComputeProviderName as string);
  return { provider: provider ?? null, compute };
}

export async function resolveComputeTarget(
  app: AppContext,
  session: Session,
): Promise<{ target: import("./compute/compute-target.js").ComputeTarget | null; compute: Compute | null }> {
  const { compute } = await resolveProvider(app, session);
  if (!compute) return { target: null, compute: null };

  const computeKind = compute.compute_kind as ComputeKind;
  const isolationKind = compute.isolation_kind as IsolationKind;

  const c = app.getCompute(computeKind);
  const r = app.getIsolation(isolationKind);
  if (!c || !r) return { target: null, compute };

  const { ComputeTarget } = await import("./compute/compute-target.js");
  return { target: new ComputeTarget(c, r, app), compute };
}
