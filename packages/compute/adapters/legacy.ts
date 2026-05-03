/**
 * Back-compat adapter: legacy `ComputeProvider` -> new `ComputeTarget`.
 *
 * Maps every known legacy provider onto its matching `(Compute, Isolation)`
 * pair:
 *
 *   LocalWorktreeProvider      -> ComputeTarget(LocalCompute, DirectIsolation)
 *   LocalDockerProvider        -> ComputeTarget(LocalCompute, DockerIsolation)
 *   LocalFirecrackerProvider   -> ComputeTarget(FirecrackerCompute, DirectIsolation)
 *   RemoteWorktreeProvider     -> ComputeTarget(EC2Compute, DirectIsolation)
 *   RemoteDockerProvider       -> ComputeTarget(EC2Compute, DockerIsolation)
 *   RemoteDevcontainerProvider -> ComputeTarget(EC2Compute, DevcontainerIsolation)
 *   RemoteFirecrackerProvider  -> null (microVM-on-EC2 composition not yet wired)
 *   K8sProvider                -> ComputeTarget(K8sCompute,  DirectIsolation)
 *   KataProvider               -> ComputeTarget(KataCompute, DirectIsolation)
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
 *     go through `DockerIsolation.launchAgent` (which reads it) rather than
 *     the Compute's default.
 *   - EC2Compute.getArkdUrl() reads `handle.meta.ec2.arkdLocalPort` (the SSH
 *     tunnel endpoint). RemoteWorktree + DirectIsolation talks to arkd through
 *     that tunnel directly. RemoteDocker / RemoteDevcontainer run their
 *     per-session container inside the EC2 instance; arkd on the instance
 *     owns the container lifecycle via the same docker / devcontainer
 *     helpers, so the DockerIsolation / DevcontainerIsolation `handle.meta.*.arkdUrl`
 *     still points at an in-instance loopback port reachable over the tunnel.
 *   - FirecrackerCompute.getArkdUrl() reads `handle.meta.firecracker.arkdUrl`
 *     (the VM's guest IP over the host-reachable TAP bridge). The caller
 *     provisions the compute, then the DirectIsolation launchAgent talks to
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
import { DirectIsolation } from "../isolation/direct.js";
import { DockerIsolation } from "../isolation/docker.js";
import { DevcontainerIsolation } from "../isolation/devcontainer.js";
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
 * @param app      -- AppContext injected into the new impls via constructor.
 */
export function computeProviderToTarget(provider: ComputeProvider, app: AppContext): ComputeTarget | null {
  if (provider instanceof LocalWorktreeProvider) {
    return new ComputeTarget(new LocalCompute(app), new DirectIsolation(app), app);
  }
  if (provider instanceof LocalDockerProvider) {
    // Docker runtime: the host is still LocalCompute (always up). The
    // per-session container lifecycle lives entirely on the runtime.
    return new ComputeTarget(new LocalCompute(app), new DockerIsolation(app), app);
  }
  if (provider instanceof LocalFirecrackerProvider) {
    // Firecracker microVM IS the compute; inside the VM the agent runs
    // natively via arkd, so the runtime is `direct`.
    return new ComputeTarget(new FirecrackerCompute(app), new DirectIsolation(app), app);
  }
  if (provider instanceof RemoteWorktreeProvider) {
    // Legacy "ec2" -- arkd runs on the instance; DirectIsolation forwards
    // launches straight through the EC2Compute SSM port-forward.
    return new ComputeTarget(new EC2Compute(app), new DirectIsolation(app), app);
  }
  if (provider instanceof RemoteDockerProvider) {
    // Legacy "ec2-docker" -- docker-in-ec2. The runtime's per-session
    // container lifecycle on the instance is identical to local docker; the
    // EC2Compute tunnel brings arkd back to the host conductor.
    return new ComputeTarget(new EC2Compute(app), new DockerIsolation(app), app);
  }
  if (provider instanceof RemoteDevcontainerProvider) {
    // Legacy "ec2-devcontainer" -- devcontainer-in-ec2. The devcontainer CLI
    // runs on the instance; EC2Compute owns the instance + tunnel.
    return new ComputeTarget(new EC2Compute(app), new DevcontainerIsolation(app), app);
  }
  if (provider instanceof RemoteFirecrackerProvider) {
    // microVM-on-EC2 composition is not yet wired; until then the legacy
    // provider stays authoritative; the null return preserves that.
    return null;
  }
  // Kata must be checked before K8s because KataProvider extends K8sProvider
  // -- an `instanceof K8sProvider` match would otherwise swallow Kata instances.
  if (provider instanceof KataProvider) {
    return new ComputeTarget(new KataCompute(app), new DirectIsolation(app), app);
  }
  if (provider instanceof K8sProvider) {
    return new ComputeTarget(new K8sCompute(app), new DirectIsolation(app), app);
  }
  // Everything else: future waves.
  return null;
}
