/**
 * Back-compat adapter: legacy `ComputeProvider` -> new `ComputeTarget`.
 *
 * Maps every known legacy provider onto its matching `(Compute, Runtime)`
 * pair:
 *
 *   LocalWorktreeProvider      -> ComputeTarget(LocalCompute, DirectRuntime)
 *   LocalDockerProvider        -> ComputeTarget(LocalCompute, DockerRuntime)
 *   LocalFirecrackerProvider   -> ComputeTarget(FirecrackerCompute, DirectRuntime)
 *   RemoteWorktreeProvider     -> ComputeTarget(EC2Compute, DirectRuntime)
 *   RemoteDockerProvider       -> ComputeTarget(EC2Compute, DockerRuntime)
 *   RemoteDevcontainerProvider -> ComputeTarget(EC2Compute, DevcontainerRuntime)
 *   RemoteFirecrackerProvider  -> null (microVM-on-EC2 composition not yet wired)
 *   K8sProvider                -> ComputeTarget(K8sCompute,  DirectRuntime)
 *   KataProvider               -> ComputeTarget(KataCompute, DirectRuntime)
 *
 * Existing DB rows (eg `provider: "docker"`, `"ec2"`, `"k8s"`, ...) keep
 * working through this mapping -- no schema migration.
 *
 * The FirecrackerCompute's own availability gate fires at provision time, so
 * constructing the target here is safe even on hosts that don't support KVM:
 * mapping the ComputeProvider onto a target never touches the kernel.
 *
 * Every other provider still returns null, and callers fall through to the
 * legacy `ComputeProvider` API as before. This file can be deleted once every
 * call site runs through ComputeTarget.
 *
 * Invariants honoured by this adapter:
 *   - LocalCompute.getArkdUrl() already reads `app.config.ports.arkd`, but
 *     for the Docker path the per-session arkd URL lives on
 *     `handle.meta.docker.arkdUrl`. Callers that want the Docker URL must
 *     go through `DockerRuntime.launchAgent` (which reads it) rather than
 *     the Compute's default.
 *   - EC2Compute.getArkdUrl() reads `handle.meta.ec2.arkdLocalPort` (the SSH
 *     tunnel endpoint). RemoteWorktree + DirectRuntime talks to arkd through
 *     that tunnel directly. RemoteDocker / RemoteDevcontainer run their
 *     per-session container inside the EC2 instance; arkd on the instance
 *     owns the container lifecycle via the same docker / devcontainer
 *     helpers, so the DockerRuntime / DevcontainerRuntime `handle.meta.*.arkdUrl`
 *     still points at an in-instance loopback port reachable over the tunnel.
 *   - FirecrackerCompute.getArkdUrl() reads `handle.meta.firecracker.arkdUrl`
 *     (the VM's guest IP over the host-reachable TAP bridge). The caller
 *     provisions the compute, then the DirectRuntime launchAgent talks to
 *     arkd on that URL.
 *   - The returned ComputeTarget is a thin view -- it does NOT re-run
 *     lifecycle on its own. Callers hold onto the legacy provider until
 *     dispatch is wired through ComputeTarget.
 */

import type { AppContext } from "../../core/app.js";
import { ComputeTarget } from "../core/compute-target.js";
import { LocalCompute } from "../core/local.js";
import { EC2Compute } from "../core/ec2.js";
import { FirecrackerCompute } from "../core/firecracker/compute.js";
import { K8sCompute } from "../core/k8s.js";
import { KataCompute } from "../core/k8s-kata.js";
import { DirectRuntime } from "../runtimes/direct.js";
import { DockerRuntime } from "../runtimes/docker.js";
import { DevcontainerRuntime } from "../runtimes/devcontainer.js";
import { LocalWorktreeProvider, LocalDockerProvider, LocalFirecrackerProvider } from "../providers/local-arkd.js";
import {
  RemoteWorktreeProvider,
  RemoteDockerProvider,
  RemoteDevcontainerProvider,
  RemoteFirecrackerProvider,
} from "../providers/remote-arkd.js";
import { K8sProvider, KataProvider } from "../providers/k8s.js";
import type { ComputeProvider } from "../types.js";

/**
 * Map a legacy `ComputeProvider` onto a `ComputeTarget`. Returns `null` for
 * providers we haven't migrated yet (today: RemoteFirecrackerProvider and
 * any future provider).
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
    return new ComputeTarget(compute, runtime, app);
  }
  if (provider instanceof LocalDockerProvider) {
    // Docker runtime: the host is still LocalCompute (always up). The
    // per-session container lifecycle lives entirely on the runtime.
    const compute = new LocalCompute();
    compute.setApp(app);
    const runtime = new DockerRuntime();
    runtime.setApp(app);
    return new ComputeTarget(compute, runtime, app);
  }
  if (provider instanceof LocalFirecrackerProvider) {
    // Firecracker microVM IS the compute; inside the VM the agent runs
    // natively via arkd, so the runtime is `direct`.
    const compute = new FirecrackerCompute();
    compute.setApp(app);
    const runtime = new DirectRuntime();
    runtime.setApp(app);
    return new ComputeTarget(compute, runtime, app);
  }
  if (provider instanceof RemoteWorktreeProvider) {
    // Legacy "ec2" -- arkd runs on the instance; DirectRuntime forwards
    // launches straight through the EC2Compute SSH tunnel.
    const compute = new EC2Compute();
    compute.setApp(app);
    const runtime = new DirectRuntime();
    runtime.setApp(app);
    return new ComputeTarget(compute, runtime, app);
  }
  if (provider instanceof RemoteDockerProvider) {
    // Legacy "ec2-docker" -- docker-in-ec2. The runtime's per-session
    // container lifecycle on the instance is identical to local docker; the
    // EC2Compute tunnel brings arkd back to the host conductor.
    const compute = new EC2Compute();
    compute.setApp(app);
    const runtime = new DockerRuntime();
    runtime.setApp(app);
    return new ComputeTarget(compute, runtime, app);
  }
  if (provider instanceof RemoteDevcontainerProvider) {
    // Legacy "ec2-devcontainer" -- devcontainer-in-ec2. The devcontainer CLI
    // runs on the instance; EC2Compute owns the instance + tunnel.
    const compute = new EC2Compute();
    compute.setApp(app);
    const runtime = new DevcontainerRuntime();
    runtime.setApp(app);
    return new ComputeTarget(compute, runtime, app);
  }
  if (provider instanceof RemoteFirecrackerProvider) {
    // microVM-on-EC2 composition is not yet wired; until then the legacy
    // provider stays authoritative; the null return preserves that.
    return null;
  }
  // Kata must be checked before K8s because KataProvider extends K8sProvider
  // -- an `instanceof K8sProvider` match would otherwise swallow Kata instances.
  if (provider instanceof KataProvider) {
    const compute = new KataCompute();
    compute.setApp(app);
    const runtime = new DirectRuntime();
    runtime.setApp(app);
    return new ComputeTarget(compute, runtime, app);
  }
  if (provider instanceof K8sProvider) {
    const compute = new K8sCompute();
    compute.setApp(app);
    const runtime = new DirectRuntime();
    runtime.setApp(app);
    return new ComputeTarget(compute, runtime, app);
  }
  // Everything else: future waves.
  return null;
}
