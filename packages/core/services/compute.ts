/**
 * ComputeService -- orchestration layer over ComputeRepository.
 *
 * Owns the domain rules that the repository intentionally lacks:
 *   - singleton: kinds whose `Compute.capabilities.singleton` is true allow
 *     at most one concrete row per tenant
 *   - initialStatus: pulled from `Compute.capabilities.initialStatus`
 *   - canDelete: deletion blocked when `Compute.capabilities.canDelete` is false
 *
 * The repo is a dumb dialect-parameterized store (`insert`, `findByKind`,
 * `get`, `list`, ...). Rules live here so a future `ControlPlaneComputeStore`
 * doesn't need to re-implement them above a different persistence layer.
 *
 * Capability lookups consult the `Compute` registered for the row's
 * `compute_kind` axis directly.
 */

import type {
  Compute,
  ComputeStatus,
  ComputeKindName,
  IsolationKindName,
  ComputeConfig,
  CreateComputeOpts,
} from "../../types/index.js";
import type { ComputeRepository } from "../repositories/compute.js";
import type { AppContext } from "../app.js";

const DEFAULT_COMPUTE_KIND: ComputeKindName = "local";
const DEFAULT_ISOLATION_KIND: IsolationKindName = "direct";

export class ComputeService {
  constructor(
    private computes: ComputeRepository,
    private app: AppContext,
  ) {}

  // ── Create: rule-aware ──────────────────────────────────────────────────

  async create(opts: CreateComputeOpts): Promise<Compute> {
    const compute_kind = (opts.compute ?? DEFAULT_COMPUTE_KIND) as ComputeKindName;
    const isolation_kind = (opts.isolation ?? DEFAULT_ISOLATION_KIND) as IsolationKindName;

    const computeImpl = this.app.getCompute(compute_kind);
    if (!computeImpl) {
      throw new Error(`Unknown compute kind: ${compute_kind}`);
    }
    const caps = computeImpl.capabilities;

    // Singleton rule: at most one concrete (non-template, non-clone) row per
    // tenant for the auto-seeded singleton pair. Today the only singleton
    // capability is `LocalCompute`'s direct-isolation row (the host running
    // ark itself); local+docker / local+devcontainer / etc. are template
    // pairs (containers per session) and are NOT singletons. We scope the
    // check to direct-isolation only for the local kind so the legacy
    // semantics carry over without inventing isolation-level capability
    // flags. Templates and clones are exempt because templates are
    // blueprints and clones carry `cloned_from`.
    const isAutoSeededPair = compute_kind === "local" && isolation_kind === "direct";
    if (caps.singleton && isAutoSeededPair && !opts.is_template && !opts.cloned_from) {
      const existing = await this.computes.findByKind(compute_kind, isolation_kind, { excludeTemplates: true });
      if (existing) {
        throw new Error(
          `Compute kind '${compute_kind}+${isolation_kind}' is a singleton -- compute '${existing.name}' already exists`,
        );
      }
    }

    // Initial status comes from Compute.capabilities. "local" starts
    // "running" (the host is always up); remote kinds start "stopped"
    // until `provision()` brings them online.
    const initialStatus = caps.initialStatus as ComputeStatus;

    return this.computes.insert({
      name: opts.name,
      compute_kind,
      isolation_kind,
      status: initialStatus,
      config: opts.config,
      is_template: opts.is_template,
      cloned_from: opts.cloned_from ?? null,
    });
  }

  // ── Read / list / update / mergeConfig: pass-through ────────────────────

  get(name: string): Promise<Compute | null> {
    return this.computes.get(name);
  }

  list(filters?: {
    status?: ComputeStatus;
    compute_kind?: ComputeKindName;
    isolation_kind?: IsolationKindName;
    limit?: number;
  }): Promise<Compute[]> {
    return this.computes.list(filters);
  }

  update(name: string, fields: Partial<Compute>): Promise<Compute | null> {
    return this.computes.update(name, fields);
  }

  mergeConfig(name: string, patch: Partial<ComputeConfig>): Promise<Compute | null> {
    return this.computes.mergeConfig(name, patch);
  }

  // ── Delete: rule-aware ──────────────────────────────────────────────────

  async delete(name: string): Promise<boolean> {
    const row = await this.computes.get(name);
    if (!row) return false;
    // canDelete=false guards the auto-seeded singleton row from accidental
    // removal (the host's `local` row). Templates (`is_template`) and
    // clones (`cloned_from`) and any user-named non-singleton rows are
    // always deletable -- the singleton-create rule above keeps there from
    // being more than one auto-seeded row per kind, so the guard scoping
    // here is "matches the canonical singleton name".
    const computeImpl = this.app.getCompute(row.compute_kind);
    const capCanDelete = computeImpl?.capabilities.canDelete;
    const isAutoSingleton = !row.is_template && !row.cloned_from && row.name === row.compute_kind;
    if (capCanDelete === false && isAutoSingleton) {
      throw new Error(`Compute kind '${row.compute_kind}' does not support deletion`);
    }
    return this.computes.delete(name);
  }

  /**
   * Garbage-collect a *clone* row even when the provider has `canDelete=false`.
   *
   * The `canDelete` guard on `delete()` exists to protect user-provisioned
   * persistent infrastructure (e.g. the singleton "local" row, a manually
   * provisioned EC2 box) from being removed through the regular lifecycle
   * GC sweep. Clones -- rows with `cloned_from` set -- are ephemeral by
   * construction: the dispatcher creates one per session and the row has
   * no meaning once the session reaches a terminal state.
   *
   * This method refuses to bypass the guard unless the row actually is a
   * clone. That asymmetry is deliberate: a caller that wants to remove a
   * non-clone row must go through `delete()` and surface the
   * `canDelete=false` error to the user.
   */
  async forceDeleteClone(name: string): Promise<boolean> {
    const row = await this.computes.get(name);
    if (!row) return false;
    if (!row.cloned_from) {
      throw new Error(`forceDeleteClone refused: '${name}' is not a clone (cloned_from is null)`);
    }
    return this.computes.delete(name);
  }
}
