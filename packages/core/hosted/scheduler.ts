/**
 * Session Scheduler -- assigns sessions to available worker nodes.
 *
 * Scheduling strategy:
 *   1. Check tenant policy (provider allowed, concurrency limit).
 *   2. Determine provider from session compute or tenant default.
 *   3. If the session requests a specific compute, find a worker on that compute.
 *   4. Otherwise, pick the least loaded available worker.
 *   5. If no workers are available, provision new compute if a pool is available.
 *   6. If nothing works, throw.
 */

import type { AppContext } from "../app.js";
import type { Session, ComputeKindName, IsolationKindName } from "../../types/index.js";
import type { WorkerNode } from "./worker-registry.js";
import type { TenantPolicyManager, TenantComputePolicy } from "../auth/index.js";

export class SessionScheduler {
  private policyManager: TenantPolicyManager | null = null;

  constructor(private app: AppContext) {}

  /** Attach a tenant policy manager for policy-aware scheduling. */
  setPolicyManager(pm: TenantPolicyManager): void {
    this.policyManager = pm;
  }

  /**
   * Schedule a session to a worker node. Returns the assigned worker.
   * Throws if no suitable worker is available or policy forbids dispatch.
   */
  async schedule(session: Session, tenantId?: string): Promise<WorkerNode> {
    const tid = tenantId ?? "default";
    const _registry = this.app.workerRegistry;

    // 1. Check tenant policy (if policy manager is available)
    let policy: TenantComputePolicy | null = null;
    if (this.policyManager) {
      const canDispatch = await this.policyManager.canDispatch(tid);
      if (!canDispatch.allowed) throw new Error(canDispatch.reason);
      policy = await this.policyManager.getEffectivePolicy(tid);
    }

    // 2. Determine provider
    let provider: string | null = null;
    if (session.compute_name) {
      provider = await this._resolveProviderFromCompute(session.compute_name);
    }
    if (!provider && policy) {
      provider = policy.default_provider;
    }

    // 3. Validate provider is allowed
    if (provider && this.policyManager && !(await this.policyManager.isProviderAllowed(tid, provider))) {
      const allowed = policy?.allowed_providers?.join(", ") ?? "all";
      throw new Error(`Provider "${provider}" not allowed for tenant "${tid}". Allowed: ${allowed}`);
    }

    // 4. Find or provision a worker
    return this._findOrProvisionWorker(session, tid, provider, policy);
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private async _findOrProvisionWorker(
    session: Session,
    tenantId: string,
    provider: string | null,
    policy: TenantComputePolicy | null,
  ): Promise<WorkerNode> {
    const registry = this.app.workerRegistry;

    // Try existing idle worker for this tenant and provider
    if (provider) {
      const tenantWorkers = await registry.getAvailable({ tenantId, computeName: provider });
      if (tenantWorkers.length > 0) return this._pickBest(tenantWorkers);

      // Try any available worker with matching provider
      const anyProvider = await registry.getAvailable({ computeName: provider });
      if (anyProvider.length > 0) return this._pickBest(anyProvider);
    }

    // If session has a specific compute, find a worker for that compute
    if (session.compute_name) {
      const workers = await registry.getAvailable({ computeName: session.compute_name });
      if (workers.length > 0) return this._pickBest(workers);
    }

    // Find any available worker
    const available = await registry.getAvailable();
    if (available.length > 0) return this._pickBest(available);

    // Try to provision new compute from pool
    if (policy && provider) {
      return this._provisionFromPool(session, tenantId, provider, policy);
    }

    // No workers available
    throw new Error("No workers available for scheduling");
  }

  private async _provisionFromPool(
    session: Session,
    tenantId: string,
    provider: string,
    policy: TenantComputePolicy,
  ): Promise<WorkerNode> {
    // Find the pool config for this provider
    const poolRef = policy.compute_pools.find((p) => p.provider === provider);
    if (!poolRef) {
      throw new Error("No workers available for scheduling");
    }

    // Check pool limits
    const registry = this.app.workerRegistry;
    const active = (await registry.list({ tenantId })).filter((w) => w.compute_name === provider).length;
    if (active >= poolRef.max) {
      throw new Error(`Pool "${poolRef.pool_name}" at max capacity (${poolRef.max})`);
    }

    // Use the new ComputeTarget API to provision. We map the legacy
    // provider-name string the policy stores to a (compute, isolation) pair
    // and look up the registered Compute impl. Until the policy schema
    // migrates to two-axis pairs, this mapping keeps the hosted scheduler
    // wired up to the new registry.
    const { compute_kind, isolation_kind } = legacyProviderNameToAxes(provider);
    const computeImpl = this.app.getCompute(compute_kind);
    if (!computeImpl) {
      throw new Error(`No compute impl registered for kind "${compute_kind}" (legacy provider "${provider}")`);
    }

    // Create compute record
    const computeName = `${tenantId}-${provider}-${Date.now()}`;
    await this.app.computeService.create({
      name: computeName,
      compute: compute_kind,
      isolation: isolation_kind,
      config: poolRef.config ?? {},
    });

    // Provision via the registered Compute impl. The handle is discarded
    // here (the hosted scheduler doesn't use it) -- the caller waits for
    // the agent to register through the worker registry below.
    await computeImpl.provision({ config: poolRef.config ?? {} });

    // Wait for worker to register
    return this._waitForWorkerRegistration(computeName, 60_000);
  }

  private async _waitForWorkerRegistration(computeName: string, timeoutMs: number): Promise<WorkerNode> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const workers = await this.app.workerRegistry.list();
      const online = workers.find((w) => w.compute_name === computeName && w.status === "online");
      if (online) return online;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Worker for compute "${computeName}" did not register within ${timeoutMs / 1000}s`);
  }

  /**
   * Resolve the legacy provider name from a compute record. Tenant policies
   * still store provider-name strings; until that schema migrates to a
   * two-axis pair we keep this small mapping local rather than reaching
   * back through a deleted adapters/ module.
   */
  private async _resolveProviderFromCompute(computeName: string): Promise<string | null> {
    const compute = await this.app.computes.get(computeName);
    if (!compute) return null;
    return axesToLegacyProviderName(compute.compute_kind, compute.isolation_kind);
  }

  /**
   * Pick the best worker from a list of candidates.
   * Uses load ratio (active_sessions / capacity) as the primary criterion.
   */
  private _pickBest(workers: WorkerNode[]): WorkerNode {
    return workers.sort((a, b) => a.active_sessions / a.capacity - b.active_sessions / b.capacity)[0];
  }
}

/**
 * Map a tenant_policies-style legacy provider name to the two-axis pair the
 * new compute registry uses. Mirrors the old `provider-map.ts`; kept inline
 * here because the hosted scheduler is the last operational caller of
 * legacy provider names and a separate refactor will collapse the
 * `tenant_policies` schema onto two-axis pairs.
 */
function legacyProviderNameToAxes(name: string): { compute_kind: ComputeKindName; isolation_kind: IsolationKindName } {
  switch (name) {
    case "local":
      return { compute_kind: "local", isolation_kind: "direct" };
    case "docker":
      return { compute_kind: "local", isolation_kind: "docker" };
    case "devcontainer":
      return { compute_kind: "local", isolation_kind: "devcontainer" };
    case "firecracker":
      return { compute_kind: "firecracker", isolation_kind: "direct" };
    case "ec2":
    case "remote-arkd":
    case "remote-worktree":
      return { compute_kind: "ec2", isolation_kind: "direct" };
    case "ec2-docker":
    case "remote-docker":
      return { compute_kind: "ec2", isolation_kind: "docker" };
    case "ec2-devcontainer":
    case "remote-devcontainer":
      return { compute_kind: "ec2", isolation_kind: "devcontainer" };
    case "k8s":
      return { compute_kind: "k8s", isolation_kind: "direct" };
    case "k8s-kata":
      return { compute_kind: "k8s-kata", isolation_kind: "direct" };
    default:
      return { compute_kind: "local", isolation_kind: "direct" };
  }
}

/** Reverse of legacyProviderNameToAxes -- used only for tenant-policy lookups. */
function axesToLegacyProviderName(compute_kind: ComputeKindName, isolation_kind: IsolationKindName): string {
  if (compute_kind === "local") {
    if (isolation_kind === "direct") return "local";
    if (isolation_kind === "docker") return "docker";
    if (isolation_kind === "devcontainer") return "devcontainer";
  }
  if (compute_kind === "ec2") {
    if (isolation_kind === "direct") return "ec2";
    if (isolation_kind === "docker") return "ec2-docker";
    if (isolation_kind === "devcontainer") return "ec2-devcontainer";
  }
  if (compute_kind === "firecracker") return "firecracker";
  if (compute_kind === "k8s") return "k8s";
  if (compute_kind === "k8s-kata") return "k8s-kata";
  return compute_kind;
}
