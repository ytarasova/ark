/**
 * Dispatch-time claude auth materialization.
 *
 * Runs just before compute launch. Two branches:
 *
 *   - Tenant bound to `api_key`:
 *       Resolve the named secret and expose ANTHROPIC_API_KEY in the
 *       launch env. The existing stage+runtime secrets pipeline doesn't
 *       cover this case (operators shouldn't have to also declare
 *       ANTHROPIC_API_KEY on every stage / runtime) so we inject it
 *       directly.
 *
 *   - Tenant bound to `subscription_blob` AND the compute is k8s-family:
 *       Fetch the blob, create a namespaced k8s Secret (one data entry
 *       per file, mode 0400), and `mergeConfig` `credsSecretName` onto
 *       the session's compute row. K8sProvider.launch already mounts a
 *       Secret named by `credsSecretName` at `/root/.claude`.
 *
 * On teardown `deletePerSessionCredsSecret` drops the Secret. Crashes
 * mid-session leak a Secret named `ark-creds-<sessionId>` in the target
 * namespace -- operators can GC those with:
 *   kubectl delete secret -l ark.dev/session-creds=true -n <ns>
 * (we apply that label below).
 */

import type { AppContext } from "../app.js";
import type { Session, Compute } from "../../types/index.js";
import { TenantClaudeAuthManager } from "../auth/tenant-claude-auth.js";
import { logDebug, logInfo, logWarn } from "../observability/structured-log.js";

/** Shape returned back to dispatch so it can merge env + record what was created. */
export interface ClaudeAuthMaterialization {
  /** Extra env vars (empty unless tenant is bound to an api-key). */
  env: Record<string, string>;
  /** Name of the per-session k8s Secret we created, if any. Used by teardown. */
  credsSecretName: string | null;
  /** Namespace the Secret was created in (needed for teardown on k8s). */
  credsSecretNamespace: string | null;
}

const EMPTY: ClaudeAuthMaterialization = { env: {}, credsSecretName: null, credsSecretNamespace: null };

/**
 * Short, k8s-safe Secret name. K8s caps resource names at 253 chars for
 * most types but at 63 for names that end up as DNS labels; session ids
 * already fit comfortably so we just prefix.
 */
export function perSessionSecretName(sessionId: string): string {
  return `ark-creds-${sessionId}`.toLowerCase();
}

/**
 * Pre-launch hook. Returns env to merge + the Secret name to stash on
 * the session config so teardown can delete it later.
 *
 * Shape of k8s API access: mirrors K8sProvider's dynamic import of
 * `@kubernetes/client-node` so we don't pay the module-load cost in
 * local / docker dispatch paths. The k8s API client is test-injectable
 * via `opts.k8sApiFactory` so unit tests never touch a real cluster.
 */
export async function materializeClaudeAuthForDispatch(
  app: AppContext,
  session: Session,
  compute: Compute | null,
  opts?: {
    k8sApiFactory?: (cfg: Record<string, unknown>) => Promise<K8sSecretsApi>;
  },
): Promise<ClaudeAuthMaterialization> {
  const tenantId = session.tenant_id ?? app.config.authSection?.defaultTenant ?? "default";
  const auth = new TenantClaudeAuthManager(app.db);
  const binding = await auth.get(tenantId);
  if (!binding) return EMPTY;

  if (binding.kind === "api_key") {
    // Inject ANTHROPIC_API_KEY into the launch env regardless of
    // compute kind. The existing stage/runtime secrets pipeline still
    // runs; the merge in dispatch overlays this on top so either path
    // works end-to-end.
    try {
      const value = await app.secrets.get(tenantId, binding.secret_ref);
      if (!value) {
        logWarn(
          "session",
          `tenant ${tenantId} bound to api_key '${binding.secret_ref}' but secret is missing; dispatch will proceed without ANTHROPIC_API_KEY`,
        );
        return EMPTY;
      }
      return { env: { ANTHROPIC_API_KEY: value }, credsSecretName: null, credsSecretNamespace: null };
    } catch (e: any) {
      logWarn("session", `failed to resolve api_key secret for tenant ${tenantId}: ${e?.message ?? e}`);
      return EMPTY;
    }
  }

  // subscription_blob: only materialize on k8s-family compute. On any
  // other compute kind the blob is irrelevant -- sessions on docker /
  // local use the host's `~/.claude` already. We still return EMPTY so
  // the caller doesn't mis-assume env was populated.
  if (!compute) return EMPTY;
  const providerName = compute.provider as string;
  if (providerName !== "k8s" && providerName !== "k8s-kata") {
    logDebug(
      "session",
      `tenant ${tenantId} bound to subscription_blob but compute '${compute.name}' is ${providerName}; skipping Secret creation`,
    );
    return EMPTY;
  }

  const cfg = (compute.config ?? {}) as Record<string, unknown>;
  const namespace = (cfg.namespace as string | undefined) ?? "ark";
  const secretName = perSessionSecretName(session.id);

  try {
    const blob = await app.secrets.getBlob(tenantId, binding.secret_ref);
    if (!blob || Object.keys(blob).length === 0) {
      logWarn(
        "session",
        `tenant ${tenantId} bound to subscription_blob '${binding.secret_ref}' but blob is missing; dispatch will proceed without /root/.claude mount`,
      );
      return EMPTY;
    }

    // Build k8s Secret data map (base64-encoded values, filenames as keys).
    const data: Record<string, string> = {};
    for (const filename of Object.keys(blob)) {
      data[filename] = Buffer.from(blob[filename]).toString("base64");
    }

    const api = await (opts?.k8sApiFactory ?? defaultK8sApiFactory)(cfg);
    await createOrReplaceSecret(api, namespace, secretName, data, session.id, compute.name);

    // Mutate the cloned compute's config so K8sProvider.launch mounts it.
    await app.computes.mergeConfig(compute.name, { credsSecretName: secretName });
    // Stash on session config so teardown can find + delete.
    await app.sessions.mergeConfig(session.id, {
      creds_secret_name: secretName,
      creds_secret_namespace: namespace,
    });
    logInfo(
      "session",
      `claude subscription_blob materialized: secret ${namespace}/${secretName} (${Object.keys(data).length} file(s))`,
    );
    return { env: {}, credsSecretName: secretName, credsSecretNamespace: namespace };
  } catch (e: any) {
    logWarn("session", `failed to materialize subscription_blob for tenant ${tenantId}: ${e?.message ?? e}`);
    return EMPTY;
  }
}

/**
 * Idempotent Secret create:
 *   1. Try createNamespacedSecret.
 *   2. On 409 Conflict, delete + recreate. Safer than `replace` because
 *      the previous Secret may have stale `data` keys we need gone, and
 *      the destination pod hasn't been created yet (we're pre-launch).
 */
async function createOrReplaceSecret(
  api: K8sSecretsApi,
  namespace: string,
  name: string,
  data: Record<string, string>,
  sessionId: string,
  computeName: string,
): Promise<void> {
  const body = {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name,
      namespace,
      labels: {
        "ark.dev/session": sessionId,
        "ark.dev/compute": computeName,
        "ark.dev/session-creds": "true",
      },
    },
    data,
  };
  try {
    await api.createNamespacedSecret({ namespace, body });
    return;
  } catch (e: any) {
    const status = extractStatusCode(e);
    if (status !== 409) throw e;
  }
  // 409: pre-existing. Delete then create fresh so stale data keys go.
  try {
    await api.deleteNamespacedSecret({ name, namespace });
  } catch (e: any) {
    const status = extractStatusCode(e);
    // Not-found here is a race with another actor deleting the same
    // name -- proceed with recreate.
    if (status && status !== 404) throw e;
  }
  await api.createNamespacedSecret({ namespace, body });
}

/** Delete a per-session creds Secret. Safe to call when the Secret is absent. */
export async function deletePerSessionCredsSecret(
  app: AppContext,
  session: Session,
  compute: Compute | null,
  opts?: {
    k8sApiFactory?: (cfg: Record<string, unknown>) => Promise<K8sSecretsApi>;
  },
): Promise<void> {
  const secretName = (session.config?.creds_secret_name as string | undefined) ?? null;
  const namespaceHint = (session.config?.creds_secret_namespace as string | undefined) ?? null;
  if (!secretName) return;
  // Derive namespace from the compute config if the session didn't stash one.
  const cfg = (compute?.config ?? {}) as Record<string, unknown>;
  const namespace = namespaceHint ?? (cfg.namespace as string | undefined) ?? "ark";

  try {
    const api = await (opts?.k8sApiFactory ?? defaultK8sApiFactory)(cfg);
    await api.deleteNamespacedSecret({ name: secretName, namespace });
    logDebug("session", `deleted creds secret ${namespace}/${secretName}`);
  } catch (e: any) {
    const status = extractStatusCode(e);
    if (status === 404) {
      logDebug("session", `creds secret ${namespace}/${secretName} already gone`);
    } else {
      logWarn("session", `failed to delete creds secret ${namespace}/${secretName}: ${e?.message ?? e}`);
    }
  } finally {
    // Clear the session config stash so repeat teardowns no-op.
    try {
      await app.sessions.mergeConfig(session.id, {
        creds_secret_name: null,
        creds_secret_namespace: null,
      });
    } catch {
      // best-effort -- session may already be gone.
    }
  }
}

// ── K8s API seam (narrow surface, test-injectable) ────────────────────

/**
 * The subset of @kubernetes/client-node CoreV1Api we use. Keeping this a
 * local interface means tests stub with a plain object; production code
 * resolves the real client via the factory below.
 */
export interface K8sSecretsApi {
  createNamespacedSecret(args: { namespace: string; body: unknown }): Promise<unknown>;
  deleteNamespacedSecret(args: { name: string; namespace: string }): Promise<unknown>;
  /**
   * Strategic-merge patch used to attach `ownerReferences` post-hoc. The
   * real `@kubernetes/client-node` CoreV1Api accepts an `options` arg with a
   * `headers` entry -- we model that explicitly so the stub in unit tests
   * can assert the content-type.
   */
  patchNamespacedSecret?(args: {
    name: string;
    namespace: string;
    body: unknown;
    options?: { headers?: Record<string, string> };
  }): Promise<unknown>;
  /** List secrets in a namespace with an optional label selector. */
  listNamespacedSecret?(args: {
    namespace: string;
    labelSelector?: string;
  }): Promise<{ items?: Array<Record<string, unknown>> }>;
}

/** Minimal pod metadata shape we require for the owner-ref patch. */
export interface PodMetaRef {
  metadata?: {
    name?: string;
    uid?: string;
  };
}

/**
 * Patch `ownerReferences` on a per-session creds Secret to point at the
 * freshly-created session Pod. Once set, k8s native garbage collection
 * deletes the Secret when the Pod is removed -- even if the daemon is
 * unavailable during teardown. This closes the "crash between Secret
 * create and session teardown" leak window.
 *
 * Best-effort: a 404 (Pod already gone / wrong secret name race) is
 * logged at warn and swallowed. Any other failure is also warned but not
 * rethrown; the session launch itself has already succeeded by the time
 * we reach here, and the boot-time reconciler will catch leaks.
 */
export async function setSecretOwnerToPod(
  app: AppContext,
  opts: {
    clusterConfig: Record<string, unknown>;
    namespace: string;
    secretName: string;
    pod: PodMetaRef;
    /**
     * Already-constructed k8s client. Preferred: the caller
     * (`K8sProvider.launch`) already has one wired up, so we reuse it
     * rather than rebuilding a KubeConfig. When omitted, falls back to
     * the default factory (used by standalone / test invocations).
     */
    api?: K8sSecretsApi;
    k8sApiFactory?: (cfg: Record<string, unknown>) => Promise<K8sSecretsApi>;
  },
): Promise<void> {
  const { clusterConfig, namespace, secretName, pod } = opts;
  const podName = pod?.metadata?.name;
  const podUid = pod?.metadata?.uid;
  if (!podName || !podUid) {
    logWarn(
      "session",
      `setSecretOwnerToPod: pod metadata missing name/uid for secret ${namespace}/${secretName}; skipping owner-ref patch`,
    );
    return;
  }
  // Narrow the AppContext reference (logs rely on structured-log's ambient
  // arkDir which boot already wired). We don't need anything off `app`
  // directly; keeping the param signature for symmetry with other helpers.
  void app;

  try {
    const api = opts.api ?? (await (opts.k8sApiFactory ?? defaultK8sApiFactory)(clusterConfig));
    if (!api.patchNamespacedSecret) {
      logWarn("session", `k8s api missing patchNamespacedSecret; cannot set owner-ref on ${namespace}/${secretName}`);
      return;
    }
    const body = {
      metadata: {
        ownerReferences: [
          {
            apiVersion: "v1",
            kind: "Pod",
            name: podName,
            uid: podUid,
            controller: false,
            blockOwnerDeletion: true,
          },
        ],
      },
    };
    await api.patchNamespacedSecret({
      name: secretName,
      namespace,
      body,
      options: { headers: { "Content-Type": "application/strategic-merge-patch+json" } },
    });
    logDebug("session", `owner-ref set on secret ${namespace}/${secretName} -> Pod ${podName} (${podUid})`);
  } catch (e: any) {
    const status = extractStatusCode(e);
    if (status === 404) {
      logWarn(
        "session",
        `setSecretOwnerToPod: 404 patching ${namespace}/${secretName} (pod or secret already gone); continuing`,
      );
      return;
    }
    logWarn("session", `setSecretOwnerToPod: failed to patch ${namespace}/${secretName}: ${e?.message ?? e}`);
  }
}

async function defaultK8sApiFactory(cfg: Record<string, unknown>): Promise<K8sSecretsApi> {
  const k8s = await import("@kubernetes/client-node");
  const kc = new k8s.KubeConfig();
  const kubeconfig = cfg.kubeconfig as string | undefined;
  if (kubeconfig) {
    kc.loadFromFile(kubeconfig);
  } else {
    kc.loadFromDefault();
  }
  const context = cfg.context as string | undefined;
  if (context) {
    if (!kc.getContextObject(context)) {
      const available = kc
        .getContexts()
        .map((c: any) => c.name)
        .join(", ");
      throw new Error(`k8s context "${context}" not found in kubeconfig. Available: ${available || "(none)"}`);
    }
    kc.setCurrentContext(context);
  }
  return kc.makeApiClient(k8s.CoreV1Api) as unknown as K8sSecretsApi;
}

/** Extract an HTTP status from various shapes of k8s client errors. */
function extractStatusCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    statusCode?: number;
    code?: number;
    response?: { statusCode?: number; status?: number };
    body?: { code?: number; status?: number };
  };
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.code === "number") return e.code;
  if (typeof e.response?.statusCode === "number") return e.response.statusCode;
  if (typeof e.response?.status === "number") return e.response.status;
  if (typeof e.body?.code === "number") return e.body.code;
  return null;
}
