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
  /**
   * Legacy path: the name of a context inside a kubeconfig file read from
   * disk. Required when `clusterName` is NOT set. Preserved for
   * backward compat with installs that keep a kubeconfig next to the daemon.
   */
  context?: string;
  /**
   * New (Phase 1) path: name of an entry in the effective cluster list
   * resolved via `resolveEffectiveClusters(app, tenantId)`. When set, the
   * provider builds its KubeConfig programmatically from the cluster entry
   * (+ secrets backend creds) instead of reading `~/.kube/config`.
   *
   * Mutually exclusive with the kubeconfig-on-disk flow; if both are set,
   * `clusterName` wins.
   */
  clusterName?: string;
  namespace: string; // required -- which namespace to provision pods in
  image: string; // required -- container image for agent pods
  kubeconfig?: string; // path to kubeconfig (default: in-cluster or ~/.kube/config)
  runtimeClassName?: string; // "kata-fc" for Firecracker, null for vanilla
  serviceAccount?: string;
  resources?: {
    cpu?: string; // e.g. "2"
    memory?: string; // e.g. "4Gi"
  };
  /**
   * Optional: mount a pre-existing Kubernetes Secret into each session pod so
   * the agent runtime (currently Claude Code) can reuse a host subscription
   * without baking creds into the image. The Secret is expected to already
   * exist in `namespace` -- this provider never creates or mutates it. Test
   * harnesses and higher-level operator flows own that step.
   *
   * Contract: the Secret is mounted read-only at `credsMountPath` (default
   * `/root/.claude`). Claude Code auto-discovers `~/.claude` as its creds
   * directory, so this matches the docker-compute convention
   * (`~/.claude -> /root/.claude:ro`). The Secret's keys become files inside
   * that directory; typically the operator stores the `.credentials.json`
   * + `.claude.json` from the host `~/.claude/` as keys on the Secret.
   */
  credsSecretName?: string;
  credsMountPath?: string; // default: "/root/.claude"
  /**
   * Optional pod-level securityContext fields. Clusters with a Pod Security
   * Standards (PSS) "restricted" admission policy reject pods that run as
   * root, so these knobs are required to make Ark pods admissible on
   * hardened clusters. Emitted into `spec.securityContext` only when at
   * least one of the fields is set -- an unconfigured compute produces no
   * `securityContext` block at all, matching the pre-hardening baseline.
   *
   * Field semantics mirror the upstream k8s PodSecurityContext shape:
   *   - `runAsNonRoot`: if true, the kubelet refuses to start any container
   *     that would run as uid 0. Fail-fast guard.
   *   - `runAsUser` / `runAsGroup`: numeric uid / gid the containers run as.
   *   - `fsGroup`: numeric gid assigned to mounted volumes so the container
   *     user can write to them (matters for `credsSecretName` mounts).
   *
   * Container-level overrides (`securityContext` on the container spec)
   * are intentionally NOT exposed in Wave 1 -- if a pod-level setting
   * isn't enough, callers can extend the K8sConfig later.
   */
  runAsNonRoot?: boolean;
  runAsUser?: number;
  runAsGroup?: number;
  fsGroup?: number;
  [key: string]: unknown;
}

/**
 * Build the pod-level `securityContext` object from the subset of k8s
 * config fields we support, or return `undefined` when none are set so the
 * caller can omit the key entirely (rather than emit `securityContext: {}`).
 *
 * Keeping this pure + exported-by-shape means it stays easy to unit-test
 * without spinning up an AppContext.
 */
function buildPodSecurityContext(cfg: K8sConfig): Record<string, unknown> | undefined {
  const sc: Record<string, unknown> = {};
  if (cfg.runAsNonRoot !== undefined) sc.runAsNonRoot = cfg.runAsNonRoot;
  if (cfg.runAsUser !== undefined) sc.runAsUser = cfg.runAsUser;
  if (cfg.runAsGroup !== undefined) sc.runAsGroup = cfg.runAsGroup;
  if (cfg.fsGroup !== undefined) sc.fsGroup = cfg.fsGroup;
  return Object.keys(sc).length > 0 ? sc : undefined;
}

/**
 * Validate the required fields on a k8s compute config and throw a clear
 * error if anything is missing. Called at the entry point of every provider
 * method so a misconfigured compute fails fast with an actionable message
 * (rather than a confusing cluster-side 404 on the wrong namespace).
 */
function requireK8sConfig(cfg: K8sConfig): void {
  // Either `clusterName` (new resolver path) or `context` (legacy on-disk
  // kubeconfig) must be set. Both missing = misconfiguration.
  if (!cfg.context && !cfg.clusterName) {
    throw new Error(
      "k8s compute is missing required `clusterName` or `context` -- which cluster to target (see docs/cluster-config.md)",
    );
  }
  if (!cfg.namespace) {
    throw new Error("k8s compute is missing required `namespace`");
  }
  if (!cfg.image) {
    throw new Error("k8s compute is missing required `image`");
  }
}

/**
 * Collect every secret name referenced by a cluster auth block so we can
 * batch-fetch them before touching the KubeConfig builder.
 */
function collectSecretNames(cluster: {
  auth: { kind: string; tokenSecret?: string; certSecret?: string; keySecret?: string; caSecret?: string };
}): string[] {
  const names: string[] = [];
  const a = cluster.auth as Record<string, string | undefined>;
  if (a.tokenSecret) names.push(a.tokenSecret);
  if (a.certSecret) names.push(a.certSecret);
  if (a.keySecret) names.push(a.keySecret);
  if (a.caSecret) names.push(a.caSecret);
  return names;
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
  readonly singleton = false;
  readonly canDelete = true;
  readonly canReboot = false;
  readonly supportsWorktree = false;
  readonly needsAuth = false;
  readonly supportsSecretMount = true;
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

    if (cfg.clusterName) {
      // New path: build the KubeConfig programmatically from the effective
      // cluster entry + secrets backend. We resolve against the compute
      // row's tenant_id (falling back to "default" when the column is
      // missing -- old-install compat).
      const tenantId = (compute as { tenant_id?: string }).tenant_id ?? "default";
      await this.buildKubeConfigFromCluster(kc, cfg.clusterName, tenantId, k8s);
    } else {
      // Legacy path: read kubeconfig from disk and pin to cfg.context.
      if (cfg.kubeconfig) {
        kc.loadFromFile(cfg.kubeconfig);
      } else {
        kc.loadFromDefault(); // in-cluster or ~/.kube/config
      }
      if (!cfg.context) {
        throw new Error("k8s compute missing `context` for kubeconfig-on-disk flow");
      }
      if (!kc.getContextObject(cfg.context)) {
        const available = kc
          .getContexts()
          .map((c: any) => c.name)
          .join(", ");
        throw new Error(`k8s context "${cfg.context}" not found in kubeconfig. Available: ${available || "(none)"}`);
      }
      kc.setCurrentContext(cfg.context);
    }

    this.kubeApi = kc.makeApiClient(k8s.CoreV1Api);
    return this.kubeApi;
  }

  /**
   * Build a KubeConfig programmatically from the effective cluster list +
   * tenant-scoped secrets. No temp files on disk. Uses
   * `KubeConfig.loadFromOptions` with explicit `clusters` / `users` /
   * `contexts` arrays (preferred over per-field setters for testability).
   *
   * `in_cluster` short-circuits via `KubeConfig.loadFromCluster()`; the
   * daemon MUST be running inside the target cluster for that mode.
   *
   * `exec` and `oidc` auth kinds are rejected with a clear Phase-2 pointer.
   */
  private async buildKubeConfigFromCluster(
    kc: any,
    clusterName: string,
    tenantId: string,
    k8s: typeof import("@kubernetes/client-node"),
  ): Promise<void> {
    const { resolveEffectiveClusters } = await import("../../core/config/clusters.js");
    if (!this.app) {
      throw new Error("K8sProvider: app context is required for clusterName resolution");
    }
    const effective = await resolveEffectiveClusters(this.app, tenantId);
    const cluster = effective.find((c) => c.name === clusterName);
    if (!cluster) {
      const names = effective.map((c) => c.name).join(", ");
      throw new Error(
        `cluster "${clusterName}" not in effective list for tenant "${tenantId}". Available: ${names || "(none)"}`,
      );
    }

    const auth = cluster.auth;
    if (auth.kind === "in_cluster") {
      // `loadFromCluster` picks up /var/run/secrets/kubernetes.io/serviceaccount/*.
      kc.loadFromCluster();
      return;
    }
    // Validate Phase-1 coverage before we fetch any secrets.
    if ((auth as any).kind === "exec" || (auth as any).kind === "oidc") {
      throw new Error(
        `auth kind "${(auth as any).kind}" not yet supported (Phase 2). Use "token" or "client_cert" for now.`,
      );
    }

    // Pull creds from the secrets backend. Every referenced secret must
    // exist for this tenant; otherwise fail fast with a message that names
    // both the cluster and the missing secret.
    const needsSecrets = collectSecretNames(cluster);
    const fetched: Record<string, string> = {};
    for (const name of needsSecrets) {
      const value = await this.app.secrets.get(tenantId, name);
      if (value == null) {
        throw new Error(`cluster "${clusterName}" requires secret "${name}" which is not set for tenant "${tenantId}"`);
      }
      fetched[name] = value;
    }

    const clusterSpec: Record<string, unknown> = {
      name: clusterName,
      server: cluster.apiEndpoint,
    };
    // CA precedence: inline `caData` on the cluster beats `caSecret` inside
    // the auth block. Inline CA is cheaper and less error-prone for public
    // certs (AWS EKS, GKE public endpoints).
    if (cluster.caData) {
      clusterSpec.caData = Buffer.from(cluster.caData, "utf-8").toString("base64");
    } else if ("caSecret" in auth && auth.caSecret && fetched[auth.caSecret]) {
      clusterSpec.caData = Buffer.from(fetched[auth.caSecret], "utf-8").toString("base64");
    } else {
      // If neither is set, callers are opting into `skipTLSVerify`. That is
      // dangerous default -- require an explicit caData for production. We
      // keep the escape hatch for dev/test kind clusters only.
      clusterSpec.skipTLSVerify = true;
    }

    const userName = `${clusterName}-user`;
    const userSpec: Record<string, unknown> = { name: userName };
    if (auth.kind === "token") {
      userSpec.token = fetched[auth.tokenSecret];
    } else if (auth.kind === "client_cert") {
      userSpec.certData = Buffer.from(fetched[auth.certSecret], "utf-8").toString("base64");
      userSpec.keyData = Buffer.from(fetched[auth.keySecret], "utf-8").toString("base64");
    }

    const contextName = `${clusterName}-ctx`;
    kc.loadFromOptions({
      clusters: [clusterSpec],
      users: [userSpec],
      contexts: [{ name: contextName, cluster: clusterName, user: userName }],
      currentContext: contextName,
    });
    // Silence unused-import warning in minified bundles; retained for the
    // type reference on the parameter signature.
    void k8s;
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

    // Optional creds mount. We deliberately do NOT default a mount on every
    // pod -- only when the operator has pre-seeded a Secret and wired it on
    // the compute row. This keeps vanilla pods creds-free (and keeps the
    // action-only e2e path unchanged).
    const credsMountPath = cfg.credsMountPath ?? "/root/.claude";
    const credsVolumes = cfg.credsSecretName
      ? [
          {
            name: "ark-creds",
            secret: {
              secretName: cfg.credsSecretName,
              // defaultMode 0400 -- read-only for the runtime user, matches
              // the local `~/.claude` permissions convention.
              defaultMode: 0o400,
            },
          },
        ]
      : [];
    const credsVolumeMounts = cfg.credsSecretName
      ? [
          {
            name: "ark-creds",
            mountPath: credsMountPath,
            readOnly: true,
          },
        ]
      : [];
    // Claude Code auto-discovers `$HOME/.claude` for credentials, so when the
    // mount lands at `/root/.claude` (the default) no env vars are needed.
    // Operators who mount elsewhere can layer their own env on the runtime
    // definition; we deliberately don't invent a non-standard override here.

    const securityContext = buildPodSecurityContext(cfg);
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
        ...(securityContext ? { securityContext } : {}),
        ...(credsVolumes.length ? { volumes: credsVolumes } : {}),
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
            ...(credsVolumeMounts.length ? { volumeMounts: credsVolumeMounts } : {}),
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

    const created = await api.createNamespacedPod({ namespace: ns, body: pod });

    // Attach the per-session creds Secret's ownerReferences to the Pod so
    // k8s native garbage collection reaps the Secret when the Pod is
    // deleted (covers daemon crashes between Secret create and session
    // teardown). Best-effort: `setSecretOwnerToPod` swallows failures --
    // the boot-time reconciler catches anything that slips through.
    if (cfg.credsSecretName && this.app) {
      try {
        const { setSecretOwnerToPod } = await import("../../core/services/dispatch-claude-auth.js");
        await setSecretOwnerToPod(this.app, {
          clusterConfig: cfg as unknown as Record<string, unknown>,
          namespace: ns,
          secretName: cfg.credsSecretName,
          pod: (created ?? pod) as { metadata?: { name?: string; uid?: string } },
          // Reuse the provider's already-initialized CoreV1Api so we don't
          // rebuild a KubeConfig just to patch one resource.
          api: api as unknown as import("../../core/services/dispatch-claude-auth.js").K8sSecretsApi,
        });
      } catch (e: any) {
        // Defensive: `setSecretOwnerToPod` already swallows its own errors,
        // but a dynamic-import failure or unexpected throw must NOT break
        // launch. Log + continue.
        logDebug("compute", `owner-ref patch threw: ${e?.message ?? e}`);
      }
    }

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

    const securityContext = buildPodSecurityContext(cfg);
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
        ...(securityContext ? { securityContext } : {}),
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
