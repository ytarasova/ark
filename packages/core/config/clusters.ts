/**
 * Cluster config -- layered k8s cluster definitions resolved at dispatch.
 *
 * Three layers merge per-cluster-name (later layer wins full replacement, NOT
 * field-level merge):
 *
 *   1. System (lowest)   -- `app.config.compute.clusters` from config.yaml /
 *                           profile defaults (the daemon operator's baseline).
 *   2. Tenant            -- YAML blob stored on `tenant_policies.compute_config_yaml`.
 *   3. User / programmatic overrides (highest, already resolved into system layer
 *      by the time we reach this module).
 *
 * Resolution returns the effective `ClusterConfig[]` a tenant can see. Policy
 * enforcement (which clusters that tenant is allowed to dispatch to) is a
 * separate step handled upstream via `TenantComputePolicy.allowed_k8s_contexts`.
 *
 * Auth modes:
 *   - `in_cluster`     -- use pod-mounted service account token. Daemon must be
 *                         running inside the target cluster.
 *   - `token`          -- bearer token from the secrets backend (tenant-scoped).
 *                         Optional CA bundle in `caSecret`.
 *   - `client_cert`    -- client certificate + key from the secrets backend.
 *   - `exec` / `oidc`  -- Phase 2. Currently rejected at KubeConfig build time.
 *
 * The secret names here are leaf names (e.g. "PROD_K8S_TOKEN"), NOT paths --
 * they map 1:1 to `SecretsCapability.get(tenantId, name)`.
 */

import YAML from "yaml";
import type { AppContext } from "../app.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type ClusterAuth =
  | { kind: "in_cluster" }
  | { kind: "token"; tokenSecret: string; caSecret?: string }
  | { kind: "client_cert"; certSecret: string; keySecret: string; caSecret?: string };

export interface ClusterConfig {
  /** Unique name within a layer, e.g. "prod-us-east". Cross-layer collision -> later layer wins. */
  name: string;
  /** Compute kind the cluster backs. */
  kind: "k8s" | "k8s-kata";
  /** Kubernetes API endpoint (https://...). */
  apiEndpoint: string;
  /** PEM-encoded CA data, inline. Mutually exclusive with `caSecret` inside auth blocks. */
  caData?: string;
  /** Namespace to default sessions into when the compute row doesn't override. */
  defaultNamespace?: string;
  /** Auth strategy. See file header. */
  auth: ClusterAuth;
}

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse a YAML blob into `ClusterConfig[]`. Throws on malformed YAML or shape
 * mismatch -- callers present these errors to operators via RPC so the
 * messages should stay actionable.
 *
 * Accepts either a top-level array `- name: ...` or a top-level object
 * `clusters: [...]` for ergonomic YAML editing. Both shapes normalize to
 * `ClusterConfig[]`.
 */
export function parseClustersYaml(yaml: string): ClusterConfig[] {
  let parsed: unknown;
  try {
    parsed = YAML.parse(yaml);
  } catch (e: any) {
    throw new Error(`Invalid YAML for cluster config: ${e?.message ?? e}`);
  }
  if (parsed == null) return [];
  const arr = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed && Array.isArray((parsed as any).clusters)
      ? (parsed as any).clusters
      : null;
  if (!arr) {
    throw new Error("Cluster config must be a YAML array or `{ clusters: [...] }`");
  }
  return arr.map((raw, idx) => validateClusterConfig(raw, `clusters[${idx}]`));
}

/**
 * Validate + narrow a raw JS object into `ClusterConfig`. Throws on any
 * missing / malformed field. Used by both the YAML parser (tenant overrides)
 * and the config surface (system-layer entries from the typed YAML loader).
 */
export function validateClusterConfig(raw: unknown, path = "cluster"): ClusterConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const name = obj.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${path}.name: required, must be a non-empty string`);
  }
  const kind = obj.kind;
  if (kind !== "k8s" && kind !== "k8s-kata") {
    throw new Error(`${path}.kind: must be "k8s" or "k8s-kata"`);
  }
  const apiEndpoint = obj.apiEndpoint ?? obj.api_endpoint;
  if (typeof apiEndpoint !== "string" || apiEndpoint.length === 0) {
    throw new Error(`${path}.apiEndpoint: required, must be a non-empty string`);
  }
  const caData = obj.caData ?? obj.ca_data;
  if (caData !== undefined && typeof caData !== "string") {
    throw new Error(`${path}.caData: must be a string (PEM) when set`);
  }
  const defaultNamespace = obj.defaultNamespace ?? obj.default_namespace;
  if (defaultNamespace !== undefined && typeof defaultNamespace !== "string") {
    throw new Error(`${path}.defaultNamespace: must be a string when set`);
  }
  const auth = validateAuth(obj.auth, `${path}.auth`);

  const out: ClusterConfig = {
    name,
    kind,
    apiEndpoint,
    auth,
  };
  if (caData !== undefined) out.caData = caData as string;
  if (defaultNamespace !== undefined) out.defaultNamespace = defaultNamespace as string;
  return out;
}

function validateAuth(raw: unknown, path: string): ClusterAuth {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === "in_cluster") return { kind };
  if (kind === "token") {
    const tokenSecret = obj.tokenSecret ?? obj.token_secret;
    if (typeof tokenSecret !== "string" || tokenSecret.length === 0) {
      throw new Error(`${path}.tokenSecret: required for kind="token"`);
    }
    const caSecret = obj.caSecret ?? obj.ca_secret;
    if (caSecret !== undefined && typeof caSecret !== "string") {
      throw new Error(`${path}.caSecret: must be a string when set`);
    }
    const out: ClusterAuth = { kind, tokenSecret };
    if (caSecret) (out as any).caSecret = caSecret;
    return out;
  }
  if (kind === "client_cert") {
    const certSecret = obj.certSecret ?? obj.cert_secret;
    const keySecret = obj.keySecret ?? obj.key_secret;
    if (typeof certSecret !== "string" || certSecret.length === 0) {
      throw new Error(`${path}.certSecret: required for kind="client_cert"`);
    }
    if (typeof keySecret !== "string" || keySecret.length === 0) {
      throw new Error(`${path}.keySecret: required for kind="client_cert"`);
    }
    const caSecret = obj.caSecret ?? obj.ca_secret;
    if (caSecret !== undefined && typeof caSecret !== "string") {
      throw new Error(`${path}.caSecret: must be a string when set`);
    }
    const out: ClusterAuth = { kind, certSecret, keySecret };
    if (caSecret) (out as any).caSecret = caSecret;
    return out;
  }
  throw new Error(`${path}.kind: must be one of "in_cluster" | "token" | "client_cert" (got ${JSON.stringify(kind)})`);
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve the effective cluster list for a tenant.
 *
 * Order (later wins on name collision, full replacement):
 *   1. System: `app.config.compute.clusters` (empty [] when not configured).
 *   2. Tenant: YAML blob stored via `setComputeConfig` on the policy manager.
 *
 * The returned list is safe to show to the tenant -- the resolver does not
 * fetch any secrets. Credential materialization happens later in the k8s
 * provider via `app.secrets.get(tenantId, secretName)`.
 */
export async function resolveEffectiveClusters(app: AppContext, tenantId: string): Promise<ClusterConfig[]> {
  const system = app.config.compute?.clusters ?? [];
  let tenantOverlay: ClusterConfig[] = [];

  try {
    // Lazy import to avoid a config -> auth -> config cycle.
    const { TenantPolicyManager } = await import("../auth/tenant-policy.js");
    const mgr = new TenantPolicyManager(app.db);
    const yaml = await mgr.getComputeConfig(tenantId);
    if (yaml && yaml.trim().length > 0) {
      tenantOverlay = parseClustersYaml(yaml);
    }
  } catch {
    // Malformed tenant YAML (should not happen -- set() validates) or missing
    // column on an older DB: fall back to system-only so dispatch keeps working.
    tenantOverlay = [];
  }

  return mergeClusterLayers(system, tenantOverlay);
}

/**
 * Merge two layers by cluster name, with `overlay` winning per-name (full
 * replacement -- no field-level merge). Exported for tests.
 */
export function mergeClusterLayers(base: ClusterConfig[], overlay: ClusterConfig[]): ClusterConfig[] {
  const byName = new Map<string, ClusterConfig>();
  for (const c of base) byName.set(c.name, c);
  for (const c of overlay) byName.set(c.name, c);
  return [...byName.values()];
}
