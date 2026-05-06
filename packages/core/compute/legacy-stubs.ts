/**
 * Operational-only stubs for the legacy `ComputeProvider` registry.
 *
 * Task 4 of the compute cleanup deleted the real `ComputeProvider`
 * implementations. Task 5 ported the capability flags onto
 * `Compute.capabilities` and swept most callers off the legacy registry.
 * The two executors (`claude-agent.ts`, `claude-code.ts`) and a handful of
 * server handlers (reboot / checkStatus / attach / getAttachCommand) still
 * reach through `app.getProvider(...)`; this file registers a stub for
 * each known legacy name so those calls find _something_ in the registry.
 *
 * Every operational method throws -- it points the caller at the new
 * `ComputeTarget` API. The capability flag readers were swept onto
 * `target.compute.capabilities` so the stubs no longer carry capability
 * data.
 */

import type { Compute, Session } from "../../types/index.js";
import type { ComputeProvider, LaunchOpts, ProvisionOpts, SyncOpts } from "./legacy-provider.js";

class LegacyOperationalStub implements ComputeProvider {
  constructor(readonly name: string) {}

  private throwOp(op: string): never {
    throw new Error(
      `LegacyOperationalStub('${this.name}').${op}() called -- migrate the call site to the new ComputeTarget API.`,
    );
  }

  provision(_compute: Compute, _opts?: ProvisionOpts): Promise<void> {
    return this.throwOp("provision");
  }
  destroy(_compute: Compute): Promise<void> {
    return this.throwOp("destroy");
  }
  start(_compute: Compute): Promise<void> {
    return this.throwOp("start");
  }
  stop(_compute: Compute): Promise<void> {
    return this.throwOp("stop");
  }
  launch(_compute: Compute, _session: Session, _opts: LaunchOpts): Promise<string> {
    return this.throwOp("launch");
  }
  attach(_compute: Compute, _session: Session): Promise<void> {
    return this.throwOp("attach");
  }
  killAgent(_compute: Compute, _session: Session): Promise<void> {
    return this.throwOp("killAgent");
  }
  captureOutput(_compute: Compute, _session: Session): Promise<string> {
    return this.throwOp("captureOutput");
  }
  cleanupSession(_compute: Compute, _session: Session): Promise<void> {
    return this.throwOp("cleanupSession");
  }
  getMetrics(_compute: Compute): Promise<never> {
    return this.throwOp("getMetrics");
  }
  probePorts(_compute: Compute): Promise<never[]> {
    return this.throwOp("probePorts");
  }
  syncEnvironment(_compute: Compute, _opts: SyncOpts): Promise<void> {
    return this.throwOp("syncEnvironment");
  }
  checkSession(_compute: Compute, _tmuxSessionId: string, _session?: Session): Promise<boolean> {
    return this.throwOp("checkSession");
  }
  getAttachCommand(_compute: Compute, _session: Session): string[] {
    return this.throwOp("getAttachCommand");
  }
  buildChannelConfig(_sessionId: string, _stage: string, _channelPort: number): Record<string, unknown> {
    return this.throwOp("buildChannelConfig");
  }
  buildLaunchEnv(_session: Session): Record<string, string> {
    return this.throwOp("buildLaunchEnv");
  }
}

/**
 * Every legacy provider name dispatch and the few remaining executor +
 * server-handler call sites might encounter. Mirrors the keys in the
 * (now-deleted) `compute/adapters/provider-map.ts` plus a handful of
 * historical aliases.
 */
const LEGACY_NAMES = [
  "local",
  "docker",
  "devcontainer",
  "firecracker",
  "ec2",
  "ec2-docker",
  "ec2-devcontainer",
  "ec2-firecracker",
  "remote-arkd",
  "remote-worktree",
  "remote-docker",
  "remote-devcontainer",
  "remote-firecracker",
  "k8s",
  "k8s-kata",
] as const;

export function buildLegacyCapabilityStubs(): ComputeProvider[] {
  return LEGACY_NAMES.map((name) => new LegacyOperationalStub(name));
}
