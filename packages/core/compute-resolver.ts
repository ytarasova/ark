/**
 * Compute / Runtime resolution helpers.
 *
 * Extracted from app.ts so AppContext stays focused on lifecycle. Both
 * helpers are pure functions over an AppContext + session; they live
 * here (not on the class) because they're used by the session resolver
 * bridge (`setProviderResolver`) and benefit from being importable
 * without the full AppContext type surface.
 */
import type { AppContext } from "./app.js";
import type { Session, Compute, ComputeProviderName } from "../types/index.js";
import type { ComputeProvider } from "../compute/types.js";
import type { ComputeKind, RuntimeKind } from "../compute/core/types.js";
import { safeParseConfig } from "./util.js";

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
  const row = (await app.db?.prepare("SELECT * FROM compute WHERE name = ?").get(computeName)) as
    | { name: string; provider: string; status: string; config: string; created_at: string; updated_at: string }
    | undefined;
  if (!row) return { provider: null, compute: null };
  const compute = { ...row, config: safeParseConfig(row.config) } as unknown as Compute;
  const provider = app.getProvider(compute.provider as ComputeProviderName as string);
  return { provider: provider ?? null, compute };
}

export async function resolveComputeTarget(
  app: AppContext,
  session: Session,
): Promise<{ target: import("../compute/core/compute-target.js").ComputeTarget | null; compute: Compute | null }> {
  const { compute } = await resolveProvider(app, session);
  if (!compute) return { target: null, compute: null };

  const { providerToPair } = await import("../compute/adapters/provider-map.js");
  const fallback = providerToPair(compute.provider);
  const computeKind = ((compute as any).compute_kind ?? fallback.compute) as ComputeKind;
  const runtimeKind = ((compute as any).runtime_kind ?? fallback.runtime) as RuntimeKind;

  const c = app.getCompute(computeKind);
  const r = app.getRuntime(runtimeKind);
  if (!c || !r) return { target: null, compute };

  const { ComputeTarget } = await import("../compute/core/compute-target.js");
  return { target: new ComputeTarget(c, r, app), compute };
}
