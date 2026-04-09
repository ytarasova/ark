/**
 * Kubernetes compute providers - vanilla pods and Kata/Firecracker variant.
 *
 * K8sProvider creates pods in a Kubernetes cluster for agent execution.
 * KataProvider extends K8sProvider with runtimeClassName defaulting to "kata-fc"
 * for Firecracker microVM isolation via Kata Containers.
 */

import type { AppContext } from "../../core/app.js";
import type {
  ComputeProvider, Compute, Session, ProvisionOpts, LaunchOpts, SyncOpts,
  IsolationMode, ComputeSnapshot, ComputeMetrics, PortDecl, PortStatus,
} from "../types.js";

export interface K8sConfig {
  provider: "k8s" | "k8s-kata";
  namespace?: string;           // default: "ark"
  image?: string;               // default: "ubuntu:22.04"
  kubeconfig?: string;          // path to kubeconfig (default: in-cluster or ~/.kube/config)
  runtimeClassName?: string;    // "kata-fc" for Firecracker, null for vanilla
  serviceAccount?: string;
  resources?: {
    cpu?: string;               // e.g. "2"
    memory?: string;            // e.g. "4Gi"
  };
  [key: string]: unknown;
}

const EMPTY_METRICS: ComputeMetrics = {
  cpu: 0, memUsedGb: 0, memTotalGb: 0, memPct: 0, diskPct: 0,
  netRxMb: 0, netTxMb: 0, uptime: "N/A", idleTicks: 0,
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

  setApp(app: AppContext): void { this.app = app; }

  private async getK8sModule(): Promise<typeof import("@kubernetes/client-node")> {
    return await import("@kubernetes/client-node");
  }

  private async getApi(compute: Compute): Promise<any> {
    if (this.kubeApi) return this.kubeApi;
    const k8s = await this.getK8sModule();
    const kc = new k8s.KubeConfig();
    const cfg = compute.config as K8sConfig;
    if (cfg.kubeconfig) {
      kc.loadFromFile(cfg.kubeconfig);
    } else {
      kc.loadFromDefault(); // in-cluster or ~/.kube/config
    }
    this.kubeApi = kc.makeApiClient(k8s.CoreV1Api);
    return this.kubeApi;
  }

  protected podName(session: Session): string {
    return `ark-${session.id}`;
  }

  async provision(compute: Compute): Promise<void> {
    // Validate K8s connectivity
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace || "ark";

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
    const ns = cfg.namespace || "ark";
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
        containers: [{
          name: "agent",
          image: cfg.image || "ubuntu:22.04",
          command: ["/bin/bash", "-c", opts.launcherContent],
          resources: cfg.resources ? {
            requests: { cpu: cfg.resources.cpu, memory: cfg.resources.memory },
            limits: { cpu: cfg.resources.cpu, memory: cfg.resources.memory },
          } : undefined,
        }],
      },
    };

    await api.createNamespacedPod({ namespace: ns, body: pod });
    return name;
  }

  async killAgent(compute: Compute, session: Session): Promise<void> {
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace || "ark";
    try {
      await api.deleteNamespacedPod({ name: this.podName(session), namespace: ns });
    } catch { /* pod may already be gone */ }
  }

  async cleanupSession(compute: Compute, session: Session): Promise<void> {
    await this.killAgent(compute, session);
  }

  async start(compute: Compute): Promise<void> {
    this.app!.computes.update(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    // Delete all ark pods in namespace
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace || "ark";
    try {
      await api.deleteCollectionNamespacedPod({
        namespace: ns,
        labelSelector: `ark.dev/compute=${compute.name}`,
      });
    } catch { /* namespace may not exist yet */ }
    this.app!.computes.update(compute.name, { status: "stopped" });
  }

  async destroy(compute: Compute): Promise<void> {
    await this.stop(compute);
    this.app!.computes.update(compute.name, { status: "destroyed" });
  }

  async attach(_compute: Compute, _session: Session): Promise<void> {
    // K8s: attach handled by kubectl exec via getAttachCommand
  }

  async captureOutput(compute: Compute, session: Session, _opts?: { lines?: number }): Promise<string> {
    const api = await this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace || "ark";
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
    const ns = cfg.namespace || "ark";
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
    const ns = cfg.namespace || "ark";
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
    return ports.map(p => ({ ...p, listening: false }));
  }

  async syncEnvironment(_compute: Compute, _opts: SyncOpts): Promise<void> {
    // K8s: sync not supported for pods (ephemeral)
  }

  getAttachCommand(compute: Compute, session: Session): string[] {
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace || "ark";
    return ["kubectl", "exec", "-it", "-n", ns, this.podName(session), "--", "/bin/bash"];
  }

  buildChannelConfig(sessionId: string, stage: string, channelPort: number, opts?: { conductorUrl?: string }): Record<string, unknown> {
    return {
      env: {
        ARK_SESSION_ID: sessionId,
        ARK_STAGE: stage,
        ARK_CHANNEL_PORT: String(channelPort),
        ARK_CONDUCTOR_URL: opts?.conductorUrl ?? process.env.ARK_CONDUCTOR_URL ?? "http://localhost:19100",
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
  readonly isolationModes: IsolationMode[] = [
    { value: "kata", label: "Kata Container (Firecracker microVM on K8s)" },
  ];

  async launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string> {
    // Ensure runtimeClassName defaults to "kata-fc" if not set
    const cfg = compute.config as K8sConfig;
    if (!cfg.runtimeClassName) {
      this.app!.computes.mergeConfig(compute.name, { runtimeClassName: "kata-fc" });
      // Re-read compute with updated config
      const updated = this.app!.computes.get(compute.name);
      if (updated) return super.launch(updated, session, opts);
    }
    return super.launch(compute, session, opts);
  }
}
