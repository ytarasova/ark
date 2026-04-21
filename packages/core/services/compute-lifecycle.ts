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

  const lifecycle = effectiveLifecycle(compute.compute_kind, compute.runtime_kind);
  if (lifecycle !== "template") return false;

  // Bail if any live session still references this compute. We deliberately
  // count *all* non-terminal sessions, not just running ones, so a session
  // that's paused / pending / waiting doesn't get its compute pulled out
  // from under it.
  const sessions = await app.sessions.list({});
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

  try {
    await app.computes.delete(computeName);
    logInfo(
      "compute-pool",
      `gc'd template compute '${computeName}' (${compute.compute_kind}/${compute.runtime_kind}) -- no live sessions reference it`,
    );
    return true;
  } catch (e: any) {
    logDebug("compute-pool", `gc failed for ${computeName}: ${e?.message ?? e}`);
    return false;
  }
}
