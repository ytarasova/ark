/**
 * Back-compat adapter: legacy `ComputeProvider` -> new `ComputeTarget`.
 *
 * Wave 1 wired `LocalWorktreeProvider` onto `LocalCompute` + `DirectRuntime`.
 * Wave 2 adds the `LocalDockerProvider` mapping: it now returns a
 * `ComputeTarget(LocalCompute, DockerRuntime)`. Existing DB rows with
 * `provider: "docker"` keep working through this mapping -- no migration.
 *
 * Every other provider still returns null, and callers fall through to the
 * legacy `ComputeProvider` API as before. Wave 3 deletes this file entirely
 * once every call site runs through ComputeTarget.
 *
 * Invariants honoured by this adapter:
 *   - LocalCompute.getArkdUrl() already reads `app.config.ports.arkd`, but
 *     for the Docker path the per-session arkd URL lives on
 *     `handle.meta.docker.arkdUrl`. Callers that want the Docker URL must
 *     go through `DockerRuntime.launchAgent` (which reads it) rather than
 *     the Compute's default.
 *   - The returned ComputeTarget is a thin view -- it does NOT re-run
 *     lifecycle on its own. Callers hold onto the legacy provider until
 *     Wave 3 wires dispatch.
 */

import type { AppContext } from "../../core/app.js";
import { ComputeTarget } from "../core/compute-target.js";
import { LocalCompute } from "../core/local.js";
import { DirectRuntime } from "../runtimes/direct.js";
import { DockerRuntime } from "../runtimes/docker.js";
import { LocalWorktreeProvider, LocalDockerProvider } from "../providers/local-arkd.js";
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
  if (provider instanceof LocalDockerProvider) {
    // Docker runtime: the host is still LocalCompute (always up). The
    // per-session container lifecycle lives entirely on the runtime.
    const compute = new LocalCompute();
    compute.setApp(app);
    const runtime = new DockerRuntime();
    runtime.setApp(app);
    return new ComputeTarget(compute, runtime);
  }
  // Everything else: Wave 2 territory.
  return null;
}
