/**
 * Back-compat adapter: legacy `ComputeProvider` -> new `ComputeTarget`.
 *
 * Wave 1 only wires the `LocalWorktreeProvider` path (because that's the only
 * (Compute, Runtime) pair that's landed: `LocalCompute` + `DirectRuntime`).
 * Every other provider returns null, and callers continue using the legacy
 * `ComputeProvider` API as they do today. Wave 2 adds more mappings; Wave 3
 * deletes this file entirely once every call site runs through ComputeTarget.
 *
 * Invariants honoured by this adapter:
 *   - LocalCompute.getArkdUrl() already reads `app.config.ports.arkd`, so we
 *     do not need to re-plumb the URL through the handle metadata.
 *   - The returned ComputeTarget is a thin view -- it does NOT re-run
 *     lifecycle on its own. Callers hold onto the legacy provider until
 *     Wave 3 wires dispatch.
 */

import type { AppContext } from "../../core/app.js";
import { ComputeTarget } from "../core/compute-target.js";
import { LocalCompute } from "../core/local.js";
import { DirectRuntime } from "../runtimes/direct.js";
import { LocalWorktreeProvider } from "../providers/local-arkd.js";
import type { ComputeProvider } from "../types.js";

/**
 * Map a legacy `ComputeProvider` onto a `ComputeTarget`. Returns `null` for
 * providers we haven't migrated yet.
 *
 * @param provider -- the legacy provider instance.
 * @param app      -- AppContext used to seed `setApp` on the new impls.
 */
export function computeProviderToTarget(provider: ComputeProvider, app: AppContext): ComputeTarget | null {
  if (provider instanceof LocalWorktreeProvider) {
    const compute = new LocalCompute();
    compute.setApp(app);
    const runtime = new DirectRuntime();
    runtime.setApp(app);
    return new ComputeTarget(compute, runtime);
  }
  // Everything else: Wave 2 territory.
  return null;
}
