/**
 * Boot-time reconciler for per-session creds Secrets.
 *
 * Covers the crash window between "Secret created" and "Pod created +
 * owner-ref patched". In that window a Secret exists with no owner, so
 * k8s GC won't touch it. On the next daemon boot we sweep for orphaned
 * (no `ownerReferences`) creds Secrets and:
 *
 *   - delete them when the owning session is in a terminal state or is
 *     no longer in the DB at all,
 *   - leave them alone when the session is still active, on the
 *     assumption that a late-arriving `setSecretOwnerToPod` will attach
 *     the owner-ref momentarily.
 *
 * All Secrets we manage are labeled `ark.dev/session-creds=true` and
 * carry the session id in `ark.dev/session`, so the list query + lookup
 * is label-driven and cheap.
 *
 * Forward-compat: when agent G's per-cluster config lands we'll walk
 * every entry in `app.config.compute.clusters`. Today we only have one
 * aggregate cluster list (top-level `config.compute.clusters`) and a
 * legacy single-cluster shape via the `compute` row; we prefer the
 * former and fall back to scanning `app.computes.list()` for legacy k8s
 * rows that don't yet surface through `clusters`.
 */

import type { AppContext } from "../app.js";
import { logDebug, logInfo, logWarn } from "../observability/structured-log.js";
import type { K8sSecretsApi } from "./dispatch-claude-auth.js";

/** Session statuses that mean "this session will never come back". */
const TERMINAL_STATES = new Set(["completed", "failed", "killed", "archived", "stopped"]);

export interface ReconcileResult {
  deleted: number;
  kept: number;
  errors: string[];
}

/**
 * Shape of a single "cluster target" the reconciler sweeps. We pass a
 * namespace + a ready-to-use `K8sSecretsApi` per cluster so the caller
 * owns client construction (and tests can stub cleanly).
 */
export interface ClusterTarget {
  clusterName: string;
  namespace: string;
  api: K8sSecretsApi;
}

/**
 * Walk every configured cluster and reconcile orphaned creds Secrets.
 *
 * Errors per-cluster are accumulated into `result.errors` rather than
 * thrown: the caller invokes this from `boot()` as a non-blocking tail
 * task, and a single mis-configured cluster must not wedge boot for the
 * whole fleet.
 */
export async function reconcileOrphanedCredsSecrets(
  app: AppContext,
  opts?: {
    /**
     * Injectable cluster enumerator. Tests supply their own list; prod
     * derives it from `app.config.compute.clusters` + default namespace
     * resolution (below).
     */
    clusterTargets?: () => Promise<ClusterTarget[]>;
  },
): Promise<ReconcileResult> {
  const result: ReconcileResult = { deleted: 0, kept: 0, errors: [] };
  let targets: ClusterTarget[] = [];
  try {
    targets = await (opts?.clusterTargets ?? (() => defaultClusterTargets(app)))();
  } catch (e: any) {
    const msg = `enumerate-clusters: ${e?.message ?? e}`;
    logWarn("session", `creds-reconciler: ${msg}`);
    result.errors.push(msg);
    return result;
  }

  for (const target of targets) {
    try {
      await reconcileOneCluster(app, target, result);
    } catch (e: any) {
      const msg = `${target.clusterName}/${target.namespace}: ${e?.message ?? e}`;
      logWarn("session", `creds-reconciler: ${msg}`);
      result.errors.push(msg);
    }
  }

  logInfo("session", "creds-reconciler: pass complete", {
    deleted: result.deleted,
    kept: result.kept,
    errors: result.errors.length,
    clusters: targets.length,
  });
  return result;
}

async function reconcileOneCluster(app: AppContext, target: ClusterTarget, result: ReconcileResult): Promise<void> {
  const { api, namespace, clusterName } = target;
  if (!api.listNamespacedSecret) {
    // Conservative: if the client we were handed has no list method we
    // can't sweep -- treat it as an error and move on rather than
    // pretending the cluster is clean.
    const msg = `${clusterName}/${namespace}: K8sSecretsApi.listNamespacedSecret not available`;
    result.errors.push(msg);
    return;
  }
  const list = await api.listNamespacedSecret({
    namespace,
    labelSelector: "ark.dev/session-creds=true",
  });
  // Snapshot into a new array -- deletions below will mutate the stub /
  // client's backing store on some implementations and we must not let
  // that shift the iteration index.
  const items = [...(list?.items ?? [])];
  for (const item of items) {
    const meta = (item.metadata ?? {}) as {
      name?: string;
      ownerReferences?: unknown[];
      labels?: Record<string, string>;
    };
    const secretName = meta.name;
    if (!secretName) continue;

    if (Array.isArray(meta.ownerReferences) && meta.ownerReferences.length > 0) {
      // k8s GC owns this one -- nothing to do.
      continue;
    }

    const sessionId = meta.labels?.["ark.dev/session"] ?? null;
    if (!sessionId) {
      // Bare label without a session id -- treat as orphan to be safe.
      await tryDelete(api, namespace, secretName, clusterName, result, "no session label");
      continue;
    }

    let session: { status?: string } | null = null;
    try {
      session = (await app.sessions.get(sessionId)) as { status?: string } | null;
    } catch (e: any) {
      // DB read failure: count as error but don't delete (err on the side
      // of retention; next boot will try again).
      const msg = `${clusterName}/${namespace}/${secretName}: session lookup failed: ${e?.message ?? e}`;
      result.errors.push(msg);
      result.kept += 1;
      continue;
    }

    if (!session) {
      await tryDelete(api, namespace, secretName, clusterName, result, "session missing");
      continue;
    }
    if (TERMINAL_STATES.has(session.status)) {
      await tryDelete(api, namespace, secretName, clusterName, result, `session ${session.status}`);
      continue;
    }
    // Active session -- assume owner-ref patch is pending. Warn once so
    // operators notice if this Secret stays orphaned across many boots.
    result.kept += 1;
    logWarn("session", `creds-reconciler: keeping ${namespace}/${secretName} (active session ${sessionId})`, {
      cluster: clusterName,
      sessionStatus: session.status,
    });
  }
}

async function tryDelete(
  api: K8sSecretsApi,
  namespace: string,
  name: string,
  clusterName: string,
  result: ReconcileResult,
  reason: string,
): Promise<void> {
  try {
    await api.deleteNamespacedSecret({ name, namespace });
    result.deleted += 1;
    logDebug("session", `creds-reconciler: deleted ${namespace}/${name} (${reason})`, { cluster: clusterName });
  } catch (e: any) {
    const status = extractStatusCode(e);
    if (status === 404) {
      // Already gone -- count as deleted since the outcome is the same.
      result.deleted += 1;
      return;
    }
    result.errors.push(`${clusterName}/${namespace}/${name}: ${e?.message ?? e}`);
  }
}

// ── Default cluster enumerator ────────────────────────────────────────
//
// Today's config shape: `app.config.compute.clusters` is a list of
// ClusterConfig entries (see `packages/core/config/clusters.ts`). We
// build a K8sSecretsApi per entry via the same programmatic-KubeConfig
// path `K8sProvider` uses. For now we keep the logic narrow -- only
// clusters reachable via the `@kubernetes/client-node` auto-loader path
// or the in-cluster service account get swept. Tenant-scoped secret
// auth is out of scope for the reconciler (it runs at boot, before any
// tenant context exists); those clusters will be left to the periodic
// janitor.

async function defaultClusterTargets(app: AppContext): Promise<ClusterTarget[]> {
  const clusters = app.config?.compute?.clusters ?? [];
  if (!clusters.length) {
    logDebug("session", "creds-reconciler: no clusters in config.compute.clusters; skipping");
    return [];
  }

  const k8s = await import("@kubernetes/client-node");
  const out: ClusterTarget[] = [];
  for (const cluster of clusters) {
    const namespace = cluster.defaultNamespace ?? "ark";
    try {
      const kc = new k8s.KubeConfig();
      if (cluster.auth.kind === "in_cluster") {
        kc.loadFromCluster();
      } else {
        // Non-in-cluster entries need tenant-scoped creds to build a
        // KubeConfig. At boot we don't have a tenant context, so defer
        // those to the periodic janitor and skip here.
        logDebug(
          "session",
          `creds-reconciler: skipping cluster ${cluster.name} (auth ${cluster.auth.kind} needs tenant ctx)`,
        );
        continue;
      }
      const api = kc.makeApiClient(k8s.CoreV1Api) as unknown as K8sSecretsApi;
      out.push({ clusterName: cluster.name, namespace, api });
    } catch (e: any) {
      logWarn("session", `creds-reconciler: failed to build client for ${cluster.name}: ${e?.message ?? e}`);
    }
  }
  return out;
}

/** Mirrors the extractor in `dispatch-claude-auth.ts` but kept local to avoid a cross-file coupling. */
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
