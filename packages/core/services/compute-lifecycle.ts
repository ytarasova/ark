/**
 * Lifecycle helpers for compute target rows.
 *
 * "Template-lifecycle" computes (k8s, docker, firecracker, ...) carry no
 * persistent infrastructure -- the row is just a config blueprint. When the
 * last session referencing such a row ends, the row itself is safe to
 * garbage-collect. This module owns that GC decision.
 *
 * Persistent-lifecycle computes (local host, ec2 fleet) keep their rows
 * around regardless of session activity -- the row models real infrastructure
 * the user explicitly provisioned.
 */

import type { AppContext } from "../app.js";
import { effectiveLifecycle } from "../../types/compute.js";
import { logDebug, logInfo } from "../observability/structured-log.js";

/**
 * If the named compute is template-lifecycle and no other live session
 * references it, delete the row. Safe to call from any session-terminal
 * code path -- a missing or in-use compute is a no-op.
 *
 * Returns true when the row was deleted, false otherwise.
 */
export async function garbageCollectComputeIfTemplate(
  app: AppContext,
  computeName: string | null | undefined,
): Promise<boolean> {
  if (!computeName) return false;
  const compute = await app.computes.get(computeName);
  if (!compute) return false;

  // Unified-model extension: rows cloned from a template at dispatch time
  // are ephemeral by construction. Collect regardless of the computed
  // lifecycle -- every session gets its own clone and no other session
  // should ever reference it by name.
  const isClone = !!compute.cloned_from;
  const lifecycle = effectiveLifecycle(compute.compute_kind, compute.isolation_kind);
  if (!isClone && lifecycle !== "template") return false;

  // A template row (`is_template: true`) is a config blueprint, never a
  // runtime target, so nothing live can legitimately reference it by
  // compute_name. Don't GC templates via this path -- removal is an
  // explicit user action.
  if (compute.is_template) return false;

  // Bail if any live session still references this compute. We deliberately
  // count *all* non-terminal sessions, not just running ones, so a session
  // that's paused / pending / waiting doesn't get its compute pulled out
  // from under it. Compute rows are tenant-scoped but GC runs from the root
  // (e.g. boot-time sweep, session termination hooks) and must count refs
  // across every tenant that might still pin the row.
  const sessions = await app.sessions.listAcrossTenants({});
  const referencing = sessions.filter(
    (s) => s.compute_name === computeName && !["completed", "failed", "stopped"].includes(s.status),
  );
  if (referencing.length > 0) {
    logDebug(
      "compute-pool",
      `gc skip ${computeName}: ${referencing.length} session(s) still reference it (statuses: ${referencing.map((s) => s.status).join(", ")})`,
    );
    return false;
  }

  // Tear down real infrastructure before deleting the DB row. For clones
  // (sessions-created or manual Provision-from-template) this is the only
  // thing that actually releases the pod / container / microVM -- without
  // it we'd leak infra in the cluster even though the row is gone. Missing
  // providers (older local-only installs) are tolerated: the row deletion
  // still proceeds.
  try {
    const { getProvider } = await import("../compute/index.js");
    const { providerOf } = await import("../compute/adapters/provider-map.js");
    const provider = getProvider(providerOf(compute));
    if (provider) {
      await provider.destroy(compute);
    }
  } catch (e: any) {
    logDebug("compute-pool", `provider.destroy during gc for ${computeName} failed: ${e?.message ?? e}`);
  }

  try {
    // P0-1: route through ComputeService so the canDelete guard runs for
    // non-clone rows. Clones are ephemeral by construction and must be
    // reapable even when the provider refuses user-initiated deletion,
    // so use the narrow bypass forceDeleteClone() for them.
    if (isClone) {
      await app.computeService.forceDeleteClone(computeName);
    } else {
      await app.computeService.delete(computeName);
    }
    const reason = isClone
      ? `cloned from '${compute.cloned_from}'`
      : `${compute.compute_kind}/${compute.isolation_kind}`;
    logInfo("compute-pool", `gc'd compute '${computeName}' (${reason}) -- no live sessions reference it`);
    return true;
  } catch (e: any) {
    logDebug("compute-pool", `gc failed for ${computeName}: ${e?.message ?? e}`);
    return false;
  }
}
