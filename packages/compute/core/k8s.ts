/**
 * K8sCompute -- migration of the legacy `K8sProvider` onto the new
 * (Compute, Runtime) split.
 *
 * Model: one Kubernetes Pod per provisioned compute. The pod runs arkd as
 * its main container; the host conductor reaches arkd through a
 * `kubectl port-forward` subprocess bound to a local loopback port. This
 * matches the arkd-sidecar invariant -- every compute target must expose
 * an arkd URL reachable from the host.
 *
 * Lifecycle:
 *   - `provision` creates the pod + spawns the port-forward, stashing both
 *     in `handle.meta.k8s` so subsequent calls are stateless.
 *   - `start` / `stop` only manage the port-forward (pods themselves are
 *     either there or not; there is no "stopped pod" concept in k8s).
 *   - `destroy` deletes the pod (and kills the port-forward).
 *   - `snapshot` / `restore` throw `NotSupportedError` -- vanilla k8s has
 *     no VM-style snapshot primitive. The `k8s-kata` subclass flips the
 *     capability flag on but still defers the real impl to a follow-up.
 *
 * The legacy adapter wires `K8sProvider` -> this class; until every
 * dispatch path goes through that adapter both live side-by-side.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { AppContext } from "../../core/app.js";
import type { Session } from "../../types/session.js";
import { allocatePort } from "../../core/config/port-allocator.js";
import type {
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  EnsureReachableOpts,
  PrepareWorkspaceOpts,
  ProvisionOpts,
  Snapshot,
} from "./types.js";
import { NotSupportedError } from "./types.js";
import { cloneWorkspaceViaArkd } from "./workspace-clone.js";
import { logDebug } from "../../core/observability/structured-log.js";
import { provisionStep } from "../../core/services/provisioning-steps.js";

/**
 * Config payload read from `ProvisionOpts.config`. Same shape as the legacy
 * `K8sConfig` -- kept unchanged so dispatch can copy the DB column straight
 * across when the legacy row is migrated.
 */
export interface K8sComputeConfig {
  /** Target namespace; defaults to "ark". */
  namespace?: string;
  /** Base image for the arkd container; defaults to "ubuntu:22.04". */
  image?: string;
  /** Path to a kubeconfig file. If unset, loads default (in-cluster or ~/.kube/config). */
  kubeconfig?: string;
  /** Kata runtime class (set by KataCompute; leave unset for vanilla). */
  runtimeClassName?: string;
  /** Pod service account name. */
  serviceAccount?: string;
  /** Resource requests/limits. */
  resources?: {
    cpu?: string;
    memory?: string;
  };
}

/** State stored on `handle.meta.k8s` after a successful `provision`. */
export interface K8sHandleMeta {
  /** Pod name in-cluster. */
  podName: string;
  /** Namespace the pod lives in. */
  namespace: string;
  /** PID of the `kubectl port-forward` subprocess (null if currently stopped). */
  portForwardPid: number | null;
  /** Host-side loopback port mapped to arkd's :19300 inside the pod. */
  arkdLocalPort: number;
  /** Optional kubeconfig path forwarded to `kubectl` invocations. */
  kubeconfig?: string;
  /** The runtimeClassName that was set on the pod spec (KataCompute). */
  runtimeClassName?: string;
}

/**
 * Injectable dependency surface. Tests swap these out to avoid touching
 * `@kubernetes/client-node` or spawning real `kubectl` subprocesses.
 */
export interface K8sComputeDeps {
  /** Lazy import of the k8s SDK. Throws if the module is not installed. */
  loadK8sModule(): Promise<typeof import("@kubernetes/client-node")>;
  /** Spawn a `kubectl port-forward` subprocess. */
  spawnPortForward(args: string[]): ChildProcess;
  /** Allocate a free ephemeral port on the host. */
  allocatePort(): Promise<number>;
  /**
   * GET <url> with a short timeout; returns true on a 2xx response. Used
   * by the reuse-path of `setupPortForward` so a stale tunnel (recycled
   * PID, evicted pod, port stolen by an unrelated process) is detected
   * before we hand the port to the conductor.
   */
  fetchHealth(url: string, timeoutMs: number): Promise<boolean>;
  /** Liveness check for a PID; mirrors the EC2 helper. */
  isPidAlive(pid: number): boolean;
  /** Send SIGTERM to a PID; swallows ESRCH so a stale meta is safe. */
  killProcess(pid: number): void;
}

async function defaultFetchHealth(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return resp.ok;
  } catch {
    return false;
  }
}

function defaultKillProcess(pid: number): void {
  if (pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    logDebug("compute", "process may already be gone");
  }
}

const DEFAULT_DEPS: K8sComputeDeps = {
  loadK8sModule: async () => await import("@kubernetes/client-node"),
  spawnPortForward: (args) => spawn("kubectl", args, { stdio: "ignore", detached: false }),
  allocatePort,
  fetchHealth: defaultFetchHealth,
  isPidAlive,
  killProcess: defaultKillProcess,
};

const ARKD_POD_PORT = 19300;

export class K8sCompute implements Compute {
  readonly kind: ComputeKind = "k8s";
  readonly capabilities: ComputeCapabilities = {
    snapshot: false,
    pool: true,
    networkIsolation: false,
    provisionLatency: "seconds",
  };

  protected deps: K8sComputeDeps = DEFAULT_DEPS;
  /** Memoized CoreV1Api client per kubeconfig path. */
  private apiCache = new Map<string, unknown>();

  constructor(protected readonly app: AppContext) {}

  /** Test-only: swap in stub deps (k8s SDK, kubectl spawn, port allocator). */
  setDeps(deps: Partial<K8sComputeDeps>): void {
    this.deps = { ...DEFAULT_DEPS, ...this.deps, ...deps };
    // Invalidate the memoized API client when deps change (new SDK mock).
    this.apiCache.clear();
  }

  protected async getApi(kubeconfig?: string): Promise<any> {
    const cacheKey = kubeconfig ?? "__default__";
    const cached = this.apiCache.get(cacheKey);
    if (cached) return cached;
    const k8s = await this.deps.loadK8sModule();
    const kc = new k8s.KubeConfig();
    if (kubeconfig) {
      kc.loadFromFile(kubeconfig);
    } else {
      kc.loadFromDefault();
    }
    const api = kc.makeApiClient(k8s.CoreV1Api);
    this.apiCache.set(cacheKey, api);
    return api;
  }

  /** Hook for subclasses (KataCompute overrides to set runtimeClassName). */
  protected augmentPodSpec(spec: Record<string, unknown>, _cfg: K8sComputeConfig): Record<string, unknown> {
    return spec;
  }

  /** Hook for subclasses so their handle.meta records the runtime class. */
  protected buildHandleMeta(base: K8sHandleMeta, _cfg: K8sComputeConfig): K8sHandleMeta {
    return base;
  }

  async provision(opts: ProvisionOpts): Promise<ComputeHandle> {
    const cfg = (opts.config ?? {}) as K8sComputeConfig;
    const namespace = cfg.namespace ?? "ark";
    const name = (opts.tags?.name as string | undefined) ?? `ark-${Date.now().toString(36)}`;
    const podName = name.startsWith("ark-") ? name : `ark-${name}`;
    const image = cfg.image ?? "ubuntu:22.04";

    const api = await this.getApi(cfg.kubeconfig);

    // Ensure namespace exists.
    try {
      await api.readNamespace({ name: namespace });
    } catch {
      try {
        await api.createNamespace({ body: { metadata: { name: namespace } } });
      } catch {
        logDebug("compute", "raced another caller; ignore");
      }
    }

    // Build the pod spec. The container runs arkd and exposes :19300.
    const containerSpec: Record<string, unknown> = {
      name: "arkd",
      image,
      command: ["/bin/sh", "-c", "arkd || sleep infinity"],
      ports: [{ containerPort: ARKD_POD_PORT, name: "arkd" }],
    };
    if (cfg.resources) {
      containerSpec.resources = {
        requests: { cpu: cfg.resources.cpu, memory: cfg.resources.memory },
        limits: { cpu: cfg.resources.cpu, memory: cfg.resources.memory },
      };
    }

    const podSpec: Record<string, unknown> = {
      restartPolicy: "Never",
      containers: [containerSpec],
    };
    if (cfg.serviceAccount) podSpec.serviceAccountName = cfg.serviceAccount;

    const pod: Record<string, unknown> = {
      metadata: {
        name: podName,
        namespace,
        labels: {
          "ark.dev/compute": name,
          "ark.dev/kind": this.kind,
        },
      },
      spec: this.augmentPodSpec(podSpec, cfg),
    };

    await api.createNamespacedPod({ namespace, body: pod });

    // Build a partial meta -- transport fields (arkdLocalPort, portForwardPid)
    // are filled in by setupPortForward, called next. Done this way so
    // setupPortForward is shared between fresh-provision and rehydrate via
    // ensureReachable.
    const meta: K8sHandleMeta = this.buildHandleMeta(
      {
        podName,
        namespace,
        portForwardPid: null,
        arkdLocalPort: 0,
        kubeconfig: cfg.kubeconfig,
      },
      cfg,
    );

    const handle: ComputeHandle = {
      kind: this.kind,
      name,
      meta: { k8s: meta },
    };

    await this.setupPortForward(handle);
    return handle;
  }

  // ── ensureReachable ──────────────────────────────────────────────────────
  //
  // Idempotent port-forward setup. On rehydrate (multi-stage flow, persisted
  // handle) the recorded port-forward PID may or may not still be running;
  // setupPortForward reuses it when alive and otherwise allocates a fresh
  // local port + spawns a new `kubectl port-forward`.
  //
  // Phases emit `provisioning_step` events so the timeline shows a uniform
  // per-step trail.

  async ensureReachable(h: ComputeHandle, opts: EnsureReachableOpts): Promise<void> {
    await this.setupPortForward(h, opts);
  }

  // ── setupPortForward (private; shared by provision + ensureReachable) ────
  //
  // Reuse the running `kubectl port-forward` if its PID is alive AND arkd
  // answers /health through it. Otherwise allocate a fresh host port +
  // spawn a new one. Mutates handle.meta.k8s so subsequent
  // `getArkdUrl(h)` calls resolve to the live tunnel.
  //
  // The /health probe matters for the reuse-path because `isPidAlive`
  // alone has three failure modes that look "alive" but don't actually
  // serve traffic:
  //   1. a kubectl process that's still running but its pod has been
  //      evicted / restarted (kubectl will reconnect, but the local
  //      socket is stalled until it does);
  //   2. a recycled PID -- the original kubectl exited and the OS
  //      handed the same number to an unrelated process;
  //   3. a stale local port held by a third party that crashed before
  //      we recorded our own PID.
  // EC2's reuse-path does the same probe; mirror it here.
  private async setupPortForward(
    h: ComputeHandle,
    opts: { app?: AppContext; sessionId?: string; onLog?: (msg: string) => void } = {},
  ): Promise<void> {
    const meta = this.readMeta(h);
    const useStep = !!opts.app && !!opts.sessionId;
    const stepCtx = { compute: h.name, podName: meta.podName, namespace: meta.namespace };

    const fn = async (): Promise<void> => {
      // Idempotent reuse: PID alive AND arkd answers /health through the
      // recorded port. Either gate failing means we kill any orphan and
      // respawn.
      if (meta.portForwardPid !== null && meta.portForwardPid > 0 && meta.arkdLocalPort > 0) {
        const pidAlive = this.deps.isPidAlive(meta.portForwardPid);
        if (pidAlive) {
          const probeUrl = `http://localhost:${meta.arkdLocalPort}/health`;
          const healthy = await this.deps.fetchHealth(probeUrl, 2000);
          if (healthy) {
            return;
          }
          // PID lives but the tunnel is dead -- pod evicted, port stolen,
          // or kubectl is "still here" but not actually forwarding. Tear
          // the orphan down before spawning fresh so we don't leak it.
          this.deps.killProcess(meta.portForwardPid);
          meta.portForwardPid = null;
          this.writeMeta(h, meta);
        }
        // PID gone (or just-killed) -- fall through to the spawn block.
      }

      const arkdLocalPort = await this.deps.allocatePort();
      const args = this.buildPortForwardArgs(meta.podName, meta.namespace, arkdLocalPort, meta.kubeconfig);
      const child = this.deps.spawnPortForward(args);
      meta.arkdLocalPort = arkdLocalPort;
      meta.portForwardPid = child.pid ?? null;
      this.writeMeta(h, meta);
    };

    if (useStep) {
      await provisionStep(opts.app!, opts.sessionId!, "k8s-port-forward", fn, { context: stepCtx });
    } else {
      await fn();
    }
  }

  async start(h: ComputeHandle): Promise<void> {
    // Pods are either there or not; starting just means re-establishing the
    // port-forward if it was stopped.
    const meta = this.readMeta(h);
    if (meta.portForwardPid) return; // already up
    const arkdLocalPort = meta.arkdLocalPort || (await this.deps.allocatePort());
    const args = this.buildPortForwardArgs(meta.podName, meta.namespace, arkdLocalPort, meta.kubeconfig);
    const child = this.deps.spawnPortForward(args);
    meta.arkdLocalPort = arkdLocalPort;
    meta.portForwardPid = child.pid ?? null;
    this.writeMeta(h, meta);
  }

  async stop(h: ComputeHandle): Promise<void> {
    const meta = this.readMeta(h);
    if (meta.portForwardPid) {
      try {
        process.kill(meta.portForwardPid, "SIGTERM");
      } catch {
        logDebug("compute", "process may already be gone");
      }
      meta.portForwardPid = null;
      this.writeMeta(h, meta);
    }
  }

  async destroy(h: ComputeHandle): Promise<void> {
    await this.stop(h);
    const meta = this.readMeta(h);
    const api = await this.getApi(meta.kubeconfig);
    try {
      await api.deleteNamespacedPod({ name: meta.podName, namespace: meta.namespace });
    } catch {
      logDebug("compute", "already gone");
    }
  }

  getArkdUrl(h: ComputeHandle): string {
    const meta = this.readMeta(h);
    return `http://localhost:${meta.arkdLocalPort}`;
  }

  // ── resolveWorkdir ───────────────────────────────────────────────────────
  //
  // Pod-side mount layout is TBD: the legacy K8sProvider didn't implement
  // this hook (sessions ran against a conductor-shared workdir under the
  // local-host adapter), and the future plan for k8s-launched arkd has not
  // yet committed to a layout (`/workspace/<sid>/<repo>` is the leading
  // candidate but not wired). Returning null here lets the dispatcher fall
  // back to `session.workdir` until the layout is decided.

  resolveWorkdir(_h: ComputeHandle, _session: Session): string | null {
    return null;
  }

  // ── prepareWorkspace ─────────────────────────────────────────────────────
  //
  // mkdir + git clone via arkd HTTP using the URL from `getArkdUrl(h)`.
  // Idempotent on the leaf path (the dispatcher's resolveWorkdir embeds
  // session.id when it lands on a fresh path; re-dispatch into the same
  // sessionId hits the same leaf and the second clone fails fast on
  // "already exists" -- caller is expected to scope per session id).
  //
  // Ordering invariant: `ensureReachable` (which sets up the kubectl
  // port-forward + binds the local arkdLocalPort) must have run on `h`
  // before this call so `getArkdUrl(h)` resolves to the live local
  // tunnel. The dispatcher's `runTargetLifecycle` enforces this.

  /**
   * Test-only: swap the helper that performs `mkdir -p` + `git clone`
   * via arkd. Default is the production `cloneWorkspaceViaArkd`.
   */
  setCloneHelperForTesting(fn: typeof cloneWorkspaceViaArkd): void {
    this.cloneHelper = fn;
  }

  protected cloneHelper: typeof cloneWorkspaceViaArkd = cloneWorkspaceViaArkd;

  async prepareWorkspace(h: ComputeHandle, opts: PrepareWorkspaceOpts): Promise<void> {
    if (!opts.source || !opts.remoteWorkdir) return;
    const arkdUrl = this.getArkdUrl(h);
    const arkdToken = process.env.ARK_ARKD_TOKEN ?? null;
    await this.cloneHelper({
      arkdUrl,
      arkdToken,
      source: opts.source,
      remoteWorkdir: opts.remoteWorkdir,
    });
  }

  async snapshot(_h: ComputeHandle): Promise<Snapshot> {
    throw new NotSupportedError(this.kind, "snapshot");
  }

  async restore(_s: Snapshot): Promise<ComputeHandle> {
    throw new NotSupportedError(this.kind, "restore");
  }

  // ── helpers ────────────────────────────────────────────────────────────

  protected readMeta(h: ComputeHandle): K8sHandleMeta {
    const meta = (h.meta as { k8s?: K8sHandleMeta }).k8s;
    if (!meta) {
      throw new Error(`K8sCompute: handle.meta.k8s is missing for "${h.name}"`);
    }
    return meta;
  }

  protected writeMeta(h: ComputeHandle, meta: K8sHandleMeta): void {
    (h.meta as { k8s?: K8sHandleMeta }).k8s = meta;
  }

  protected buildPortForwardArgs(pod: string, namespace: string, hostPort: number, kubeconfig?: string): string[] {
    const args: string[] = [];
    if (kubeconfig) args.push("--kubeconfig", kubeconfig);
    args.push("port-forward", "-n", namespace, `pod/${pod}`, `${hostPort}:${ARKD_POD_PORT}`);
    return args;
  }
}

/**
 * Probe whether `pid` names a live process. `process.kill(pid, 0)` is the
 * canonical zero-cost liveness probe on POSIX -- a permissions error is
 * still "the pid is alive" so we treat EPERM as live; only ESRCH means the
 * process is gone.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EPERM") return true;
    return false;
  }
}
