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

import type { AppContext } from "./app.js";
import type { Session } from "../types/index.js";
import type { WorkerNode } from "./worker-registry.js";
import type { TenantPolicyManager, TenantComputePolicy } from "./tenant-policy.js";

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
    const registry = this.app.workerRegistry;

    // 1. Check tenant policy (if policy manager is available)
    let policy: TenantComputePolicy | null = null;
    if (this.policyManager) {
      const canDispatch = this.policyManager.canDispatch(tid);
      if (!canDispatch.allowed) throw new Error(canDispatch.reason);
      policy = this.policyManager.getEffectivePolicy(tid);
    }

    // 2. Determine provider
    let provider: string | null = null;
    if (session.compute_name) {
      provider = this._resolveProviderFromCompute(session.compute_name);
    }
    if (!provider && policy) {
      provider = policy.default_provider;
    }

    // 3. Validate provider is allowed
    if (provider && this.policyManager && !this.policyManager.isProviderAllowed(tid, provider)) {
      const allowed = policy?.allowed_providers?.join(", ") ?? "all";
      throw new Error(
        `Provider "${provider}" not allowed for tenant "${tid}". Allowed: ${allowed}`
      );
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
      const tenantWorkers = registry.getAvailable({ tenantId, computeName: provider });
      if (tenantWorkers.length > 0) return this._pickBest(tenantWorkers);

      // Try any available worker with matching provider
      const anyProvider = registry.getAvailable({ computeName: provider });
      if (anyProvider.length > 0) return this._pickBest(anyProvider);
    }

    // If session has a specific compute, find a worker for that compute
    if (session.compute_name) {
      const workers = registry.getAvailable({ computeName: session.compute_name });
      if (workers.length > 0) return this._pickBest(workers);
    }

    // Find any available worker
    const available = registry.getAvailable();
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
    const poolRef = policy.compute_pools.find(p => p.provider === provider);
    if (!poolRef) {
      throw new Error("No workers available for scheduling");
    }

    // Check pool limits
    const registry = this.app.workerRegistry;
    const active = registry.list({ tenantId }).filter(
      w => w.compute_name === provider
    ).length;
    if (active >= poolRef.max) {
      throw new Error(
        `Pool "${poolRef.pool_name}" at max capacity (${poolRef.max})`
      );
    }

    // Use the compute provider to provision
    const computeProvider = this.app.getProvider(provider);
    if (!computeProvider) {
      throw new Error(`No compute provider registered for "${provider}"`);
    }

    // Create compute record
    const computeName = `${tenantId}-${provider}-${Date.now()}`;
    this.app.computes.create({
      name: computeName,
      provider: provider as any,
      config: poolRef.config ?? {},
    });
    const compute = this.app.computes.get(computeName)!;

    // Provision
    await computeProvider.provision(compute);

    // Wait for worker to register
    return this._waitForWorkerRegistration(computeName, 60_000);
  }

  private async _waitForWorkerRegistration(
    computeName: string,
    timeoutMs: number,
  ): Promise<WorkerNode> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const workers = this.app.workerRegistry.list();
      const online = workers.find(
        w => w.compute_name === computeName && w.status === "online"
      );
      if (online) return online;
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(
      `Worker for compute "${computeName}" did not register within ${timeoutMs / 1000}s`
    );
  }

  /** Resolve the provider name from a compute record. */
  private _resolveProviderFromCompute(computeName: string): string | null {
    const compute = this.app.computes.get(computeName);
    return compute?.provider ?? null;
  }

  /**
   * Pick the best worker from a list of candidates.
   * Uses load ratio (active_sessions / capacity) as the primary criterion.
   */
  private _pickBest(workers: WorkerNode[]): WorkerNode {
    return workers.sort((a, b) =>
      (a.active_sessions / a.capacity) - (b.active_sessions / b.capacity)
    )[0];
  }
}
