/**
 * Capability-only stubs for the legacy `ComputeProvider` registry.
 *
 * Task 4 of the compute cleanup deleted the real `ComputeProvider`
 * implementations (LocalWorktreeProvider, RemoteWorktreeProvider, etc.) but
 * the legacy `app.getProvider()` registry still has callers that read
 * capability flags (`provider.singleton`, `provider.canDelete`,
 * `provider.supportsWorktree`, `provider.initialStatus`,
 * `provider.supportsSecretMount`). Until Task 5 sweeps every such caller
 * over to the new `Compute` + `Isolation` interfaces, we register these
 * lightweight stubs so capability lookups keep working.
 *
 * The stubs only carry capability flags. Every operational method
 * (`provision`, `launch`, `cleanupSession`, ...) throws -- those code
 * paths run through `ComputeTarget` (the new two-axis dispatch) now, and
 * any caller still poking at the legacy provider for behaviour rather
 * than capabilities is a bug Task 5 must fix.
 */

import type { Compute, Session } from "../../types/index.js";
import type { ComputeProvider, IsolationMode, LaunchOpts, ProvisionOpts, SyncOpts } from "./legacy-provider.js";

interface CapabilitySpec {
  readonly name: string;
  readonly isolationModes: IsolationMode[];
  readonly singleton: boolean;
  readonly canReboot: boolean;
  readonly canDelete: boolean;
  readonly supportsWorktree: boolean;
  readonly initialStatus: string;
  readonly needsAuth: boolean;
  readonly supportsSecretMount: boolean;
}

class LegacyCapabilityStub implements ComputeProvider {
  readonly name: string;
  readonly isolationModes: IsolationMode[];
  readonly singleton: boolean;
  readonly canReboot: boolean;
  readonly canDelete: boolean;
  readonly supportsWorktree: boolean;
  readonly initialStatus: string;
  readonly needsAuth: boolean;
  readonly supportsSecretMount: boolean;

  constructor(spec: CapabilitySpec) {
    this.name = spec.name;
    this.isolationModes = spec.isolationModes;
    this.singleton = spec.singleton;
    this.canReboot = spec.canReboot;
    this.canDelete = spec.canDelete;
    this.supportsWorktree = spec.supportsWorktree;
    this.initialStatus = spec.initialStatus;
    this.needsAuth = spec.needsAuth;
    this.supportsSecretMount = spec.supportsSecretMount;
  }

  private throwOp(op: string): never {
    throw new Error(
      `LegacyCapabilityStub('${this.name}').${op}() called -- migrate the call site to the new ComputeTarget API.`,
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

const LOCAL_ISOLATION_MODES: IsolationMode[] = [
  { value: "worktree", label: "Worktree" },
  { value: "inplace", label: "In-place" },
];

const CONTAINER_ISOLATION_MODES: IsolationMode[] = [{ value: "container", label: "Container" }];

const REMOTE_ISOLATION_MODES: IsolationMode[] = [{ value: "remote", label: "Remote worktree" }];

/**
 * Capability table for every legacy provider name. Mirrors the flags the
 * deleted classes exposed; the operational methods are implemented as
 * throw-on-call stubs.
 */
const LEGACY_SPECS: CapabilitySpec[] = [
  {
    name: "local",
    isolationModes: LOCAL_ISOLATION_MODES,
    singleton: true,
    canReboot: false,
    canDelete: false,
    supportsWorktree: true,
    initialStatus: "running",
    needsAuth: false,
    supportsSecretMount: false,
  },
  {
    name: "docker",
    isolationModes: CONTAINER_ISOLATION_MODES,
    singleton: false,
    canReboot: false,
    canDelete: true,
    supportsWorktree: true,
    initialStatus: "stopped",
    needsAuth: false,
    supportsSecretMount: false,
  },
  {
    name: "devcontainer",
    isolationModes: CONTAINER_ISOLATION_MODES,
    singleton: false,
    canReboot: false,
    canDelete: true,
    supportsWorktree: true,
    initialStatus: "stopped",
    needsAuth: false,
    supportsSecretMount: false,
  },
  {
    name: "firecracker",
    isolationModes: [{ value: "vm", label: "MicroVM" }],
    singleton: false,
    canReboot: true,
    canDelete: true,
    supportsWorktree: false,
    initialStatus: "stopped",
    needsAuth: false,
    supportsSecretMount: false,
  },
  {
    name: "ec2",
    isolationModes: REMOTE_ISOLATION_MODES,
    singleton: false,
    canReboot: true,
    canDelete: true,
    supportsWorktree: false,
    initialStatus: "stopped",
    needsAuth: true,
    supportsSecretMount: false,
  },
  {
    name: "ec2-docker",
    isolationModes: CONTAINER_ISOLATION_MODES,
    singleton: false,
    canReboot: true,
    canDelete: true,
    supportsWorktree: false,
    initialStatus: "stopped",
    needsAuth: true,
    supportsSecretMount: false,
  },
  {
    name: "ec2-devcontainer",
    isolationModes: CONTAINER_ISOLATION_MODES,
    singleton: false,
    canReboot: true,
    canDelete: true,
    supportsWorktree: false,
    initialStatus: "stopped",
    needsAuth: true,
    supportsSecretMount: false,
  },
  {
    name: "ec2-firecracker",
    isolationModes: [{ value: "vm", label: "MicroVM" }],
    singleton: false,
    canReboot: true,
    canDelete: true,
    supportsWorktree: false,
    initialStatus: "stopped",
    needsAuth: true,
    supportsSecretMount: false,
  },
  {
    name: "k8s",
    isolationModes: [{ value: "pod", label: "Pod" }],
    singleton: false,
    canReboot: false,
    canDelete: true,
    supportsWorktree: false,
    initialStatus: "stopped",
    needsAuth: true,
    supportsSecretMount: true,
  },
  {
    name: "k8s-kata",
    isolationModes: [{ value: "pod", label: "Pod" }],
    singleton: false,
    canReboot: false,
    canDelete: true,
    supportsWorktree: false,
    initialStatus: "stopped",
    needsAuth: true,
    supportsSecretMount: true,
  },
];

export function buildLegacyCapabilityStubs(): ComputeProvider[] {
  return LEGACY_SPECS.map((spec) => new LegacyCapabilityStub(spec));
}
