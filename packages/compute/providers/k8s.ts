/**
 * Kubernetes compute providers - vanilla pods and Kata/Firecracker variant.
 *
 * K8sProvider creates pods in a Kubernetes cluster for agent execution.
 * KataProvider extends K8sProvider with runtimeClassName defaulting to "kata-fc"
 * for Firecracker microVM isolation via Kata Containers.
 */

import type { AppContext } from "../../core/app.js";
import type {
  ComputeProvider,
  Compute,
  Session,
  LaunchOpts,
  SyncOpts,
  IsolationMode,
  ComputeSnapshot,
  ComputeMetrics,
  PortDecl,
  PortStatus,
} from "../types.js";
import { DEFAULT_CONDUCTOR_URL } from "../../core/constants.js";
import { logDebug } from "../../core/observability/structured-log.js";

export interface K8sConfig {
  provider: "k8s" | "k8s-kata";
  context: string; // kubeconfig context (required) -- which cluster to target
  namespace: string; // required -- which namespace to provision pods in
  image: string; // required -- container image for agent pods
  kubeconfig?: string; // path to kubeconfig (default: in-cluster or ~/.kube/config)
  runtimeClassName?: string; // "kata-fc" for Firecracker, null for vanilla
  serviceAccount?: string;
  resources?: {
    cpu?: string; // e.g. "2"
    memory?: string; // e.g. "4Gi"
  };
  [key: string]: unknown;
}

/**
 * Validate the required fields on a k8s compute config and throw a clear
 * error if anything is missing. Called at the entry point of every provider
 * method so a misconfigured compute fails fast with an actionable message
 * (rather than a confusing cluster-side 404 on the wrong namespace).
 */
function requireK8sConfig(cfg: K8sConfig): void {
  if (!cfg.context) {
    throw new Error("k8s compute is missing required `context` -- which kubeconfig context (cluster) to target");
  }
  if (!cfg.namespace) {
    throw new Error("k8s compute is missing required `namespace`");
  }
  if (!cfg.image) {
    throw new Error("k8s compute is missing required `image`");
  }
}

const EMPTY_METRICS: ComputeMetrics = {
  cpu: 0,
  memUsedGb: 0,
  memTotalGb: 0,
  memPct: 0,
  diskPct: 0,
  netRxMb: 0,
  netTxMb: 0,
  uptime: "N/A",
  idleTicks: 0,
};

export class K8sProvider implements ComputeProvider {
  readonly name: string = "k8s";
  readonly isolationModes: IsolationMode[] = [
    { value: "pod", label: "Kubernetes Pod" },
    { value: "kata", label: "Kata Container (Firecracker microVM)" },
  ];
  readonly canDelete = true;
  readonly canReboot = false;
  readonly supportsWorktree = false;
  readonly needsAuth = false;
  readonly initialStatus = "stopped";

  protected app: AppContext | null = null;
  private kubeApi: any | null = null;

  setApp(app: AppContext): void {
    this.app = app;
  }

  private async getK8sModule(): Promise<typeof import("@kubernetes/client-node")> {
    return await import("@kubernetes/client-node");
  }

  private async getApi(compute: Compute): Promise<any> {
    if (this.kubeApi) return this.kubeApi;
    const cfg = compute.config as K8sConfig;
    requireK8sConfig(cfg);
    const k8s = await this.getK8sModule();
    const kc = new k8s.KubeConfig();
    if (cfg.kubeconfig) {
      kc.loadFromFile(cfg.kubeconfig);
    } else {
      kc.loadFromDefault(); // in-cluster or ~/.kube/config
    }
    // Pin to the configured context. Without this, kc would use whatever
    // current-context the kubeconfig file happens to have set -- which is
    // exactly the silent-default footgun this provider used to have.
    if (!kc.getContextObject(cfg.context)) {
      const available = kc
        .getContexts()
        .map((c: any) => c.name)
        .join(", ");
      throw new Error(`k8s context "${cfg.context}" not found in kubeconfig. Available: ${available || "(none)"}`);
    }
    kc.setCurrentContext(cfg.context);
    this.kubeApi = kc.makeApiClient(k8s.CoreV1Api);
    return this.kubeApi;
  }

  protected podName(session: Session): string {
    return `ark-${session.id}`;
  }

  /**
   * The name of the long-lived instance pod backing a concrete compute row.
   * Separate from session-scoped pods (`ark-<sessionId>`) so Start / Stop
   * on the compute only touches the instance, leaving session pods alone.
   */
  protected instancePodName(compute: Compute): string {
    return `ark-compute-${compute.name}`;
  }

  async provision(compute: Compute): Promise<void> {
    // Validate K8s connectivity
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace;

    // Ensure namespace exists
    try {
      await api.readNamespace({ name: ns });
    } catch {
      await api.createNamespace({ body: { metadata: { name: ns } } });
    }

    this.app!.computes.update(compute.name, { status: "running" });
  }

  async launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string> {
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace;
    const name = this.podName(session);

    const pod = {
      metadata: {
        name,
        namespace: ns,
        labels: {
          "ark.dev/session": session.id,
          "ark.dev/compute": compute.name,
        },
      },
      spec: {
        restartPolicy: "Never",
        ...(cfg.runtimeClassName ? { runtimeClassName: cfg.runtimeClassName } : {}),
        ...(cfg.serviceAccount ? { serviceAccountName: cfg.serviceAccount } : {}),
        containers: [
          {
            name: "agent",
            image: cfg.image,
            // `/bin/sh` is present in every reasonable container image (alpine
            // has no bash, ubuntu/debian both have /bin/sh via dash). The
            // launcher content is `buildLauncher()` output which begins with
            // a `#!/bin/bash` shebang, so bashisms inside the script still
            // require bash in the image -- but that's the script's problem,
            // not ours: `/bin/sh -c` just needs to execute the first line.
            command: ["/bin/sh", "-c", opts.launcherContent],
            resources: cfg.resources
              ? {
                  requests: { cpu: cfg.resources.cpu, memory: cfg.resources.memory },
                  limits: { cpu: cfg.resources.cpu, memory: cfg.resources.memory },
                }
              : undefined,
          },
        ],
      },
    };

    await api.createNamespacedPod({ namespace: ns, body: pod });
    return name;
  }

  async killAgent(compute: Compute, session: Session): Promise<void> {
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace;
    try {
      await api.deleteNamespacedPod({ name: this.podName(session), namespace: ns });
    } catch {
      logDebug("compute", "pod may already be gone");
    }
  }

  async cleanupSession(compute: Compute, session: Session): Promise<void> {
    await this.killAgent(compute, session);
  }

  /**
   * Start the long-lived instance pod for this compute target.
   *
   * Historically this just flipped `status=running` in the DB without
   * creating any actual infrastructure, which left the UI showing "running"
   * for a compute with zero pods behind it. Now it creates an
   * `ark-compute-<name>` pod with the configured image + resources, running
   * `sleep infinity` as a placeholder keep-alive command. Sessions still
   * spawn their own per-session pods via `launch()`; the instance pod is
   * separate and only exists to back the "concrete compute target" model.
   */
  async start(compute: Compute): Promise<void> {
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace;
    const name = this.instancePodName(compute);

    // Ensure namespace exists -- provision() usually handles this but Start
    // may be called fresh on a row created directly via `ark compute create`.
    try {
      await api.readNamespace({ name: ns });
    } catch {
      await api.createNamespace({ body: { metadata: { name: ns } } });
    }

    // If the pod already exists (user clicked Start twice, or a previous
    // Start raced), leave it alone -- idempotent by design.
    try {
      await api.readNamespacedPod({ name, namespace: ns });
      await this.app!.computes.update(compute.name, { status: "running" });
      return;
    } catch {
      // fall through to create
    }

    const pod = {
      metadata: {
        name,
        namespace: ns,
        labels: {
          "ark.dev/compute": compute.name,
          "ark.dev/role": "instance",
        },
      },
      spec: {
        restartPolicy: "Always",
        ...(cfg.runtimeClassName ? { runtimeClassName: cfg.runtimeClassName } : {}),
        ...(cfg.serviceAccount ? { serviceAccountName: cfg.serviceAccount } : {}),
        containers: [
          {
            name: "instance",
            image: cfg.image,
            // Keep-alive placeholder. Sessions exec into the pod (or the
            // session path creates its own pod) when they need to do work.
            // A future version can replace this with an arkd entrypoint.
            command: ["/bin/sh", "-c", "sleep infinity"],
            resources: cfg.resources
              ? {
                  requests: { cpu: cfg.resources.cpu, memory: cfg.resources.memory },
                  limits: { cpu: cfg.resources.cpu, memory: cfg.resources.memory },
                }
              : undefined,
          },
        ],
      },
    };

    await api.createNamespacedPod({ namespace: ns, body: pod });
    await this.app!.computes.update(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    // Delete only the instance pod -- session pods are managed separately
    // via cleanupSession and must not be interrupted when a user stops the
    // compute target (stopping also wouldn't make sense mid-session).
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace;
    try {
      await api.deleteNamespacedPod({ name: this.instancePodName(compute), namespace: ns });
    } catch {
      logDebug("compute", "instance pod may already be gone");
    }
    await this.app!.computes.update(compute.name, { status: "stopped" });
  }

  async destroy(compute: Compute): Promise<void> {
    // Destroy is broader: tear down the instance AND any lingering session
    // pods so the row can be deleted without leaving orphans behind.
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace;
    try {
      await api.deleteCollectionNamespacedPod({
        namespace: ns,
        labelSelector: `ark.dev/compute=${compute.name}`,
      });
    } catch {
      logDebug("compute", "namespace may not exist yet");
    }
    await this.app!.computes.update(compute.name, { status: "destroyed" });
  }

  async attach(_compute: Compute, _session: Session): Promise<void> {
    // K8s: attach handled by kubectl exec via getAttachCommand
  }

  async captureOutput(compute: Compute, session: Session, _opts?: { lines?: number }): Promise<string> {
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace;
    try {
      const res = await api.readNamespacedPodLog({
        name: this.podName(session),
        namespace: ns,
        tailLines: _opts?.lines || 100,
      });
      return typeof res === "string" ? res : "";
    } catch {
      return "";
    }
  }

  async checkSession(compute: Compute, tmuxSessionId: string): Promise<boolean> {
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace;
    try {
      const pod = await api.readNamespacedPod({ name: tmuxSessionId, namespace: ns });
      const phase = pod?.status?.phase;
      return phase === "Running" || phase === "Pending";
    } catch {
      return false;
    }
  }

  async getMetrics(compute: Compute): Promise<ComputeSnapshot> {
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace;
    try {
      const { items } = await api.listNamespacedPod({
        namespace: ns,
        labelSelector: `ark.dev/compute=${compute.name}`,
      });
      return {
        metrics: EMPTY_METRICS,
        sessions: [],
        processes: (items || []).map((p: any) => ({
          pid: "0",
          cpu: "N/A",
          mem: "N/A",
          command: p.metadata?.name || "",
          workingDir: "",
        })),
        docker: [],
      };
    } catch {
      return { metrics: EMPTY_METRICS, sessions: [], processes: [], docker: [] };
    }
  }

  async probePorts(_compute: Compute, ports: PortDecl[]): Promise<PortStatus[]> {
    return ports.map((p) => ({ ...p, listening: false }));
  }

  async syncEnvironment(_compute: Compute, _opts: SyncOpts): Promise<void> {
    // K8s: sync not supported for pods (ephemeral)
  }

  getAttachCommand(compute: Compute, session: Session): string[] {
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace;
    return ["kubectl", "exec", "-it", "-n", ns, this.podName(session), "--", "/bin/bash"];
  }

  buildChannelConfig(
    sessionId: string,
    stage: string,
    channelPort: number,
    opts?: { conductorUrl?: string },
  ): Record<string, unknown> {
    return {
      env: {
        ARK_SESSION_ID: sessionId,
        ARK_STAGE: stage,
        ARK_CHANNEL_PORT: String(channelPort),
        ARK_CONDUCTOR_URL: opts?.conductorUrl ?? DEFAULT_CONDUCTOR_URL,
      },
    };
  }

  buildLaunchEnv(_session: Session): Record<string, string> {
    return {};
  }
}

/**
 * K8s with Kata Containers (Firecracker microVM isolation).
 * Same as K8sProvider but defaults runtimeClassName to "kata-fc".
 */
export class KataProvider extends K8sProvider {
  readonly name = "k8s-kata";
  readonly isolationModes: IsolationMode[] = [{ value: "kata", label: "Kata Container (Firecracker microVM on K8s)" }];

  async launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string> {
    // Ensure runtimeClassName defaults to "kata-fc" if not set
    const cfg = compute.config as K8sConfig;
    if (!cfg.runtimeClassName) {
      await this.app!.computes.mergeConfig(compute.name, { runtimeClassName: "kata-fc" });
      // Re-read compute with updated config
      const updated = await this.app!.computes.get(compute.name);
      if (updated) return super.launch(updated, session, opts);
    }
    return super.launch(compute, session, opts);
  }
}
