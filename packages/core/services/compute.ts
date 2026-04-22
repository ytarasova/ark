/**
 * ComputeService -- orchestration layer over ComputeRepository.
 *
 * Owns the domain rules that the repository intentionally lacks:
 *   - singleton: providers marked `singleton` allow at most one concrete row
 *   - initialStatus: pulled from the provider (e.g. "local" -> "running")
 *   - canDelete: deletion blocked when the provider refuses it
 *
 * The repo is a dumb dialect-parameterized store (`insert`, `findByProvider`,
 * `get`, `list`, ...). Rules live here so a future `ControlPlaneComputeStore`
 * doesn't need to re-implement them above a different persistence layer.
 */

import type {
  Compute,
  ComputeStatus,
  ComputeProviderName,
  ComputeKindName,
  RuntimeKindName,
  ComputeConfig,
  CreateComputeOpts,
} from "../../types/index.js";
import type { ComputeRepository } from "../repositories/compute.js";
import type { AppContext } from "../app.js";
import { providerToPair, pairToProvider } from "../../compute/adapters/provider-map.js";

export class ComputeService {
  private _app: AppContext | null = null;

  constructor(
    private computes: ComputeRepository,
    app?: AppContext,
  ) {
    if (app) this._app = app;
  }

  /**
   * Inject AppContext after construction. Prefer the constructor argument;
   * this setter exists for DI wiring sequences that can't get `app` up front.
   */
  setApp(app: AppContext): void {
    this._app = app;
  }

  private get app(): AppContext {
    if (!this._app) throw new Error("ComputeService: AppContext not set -- pass app to constructor or call setApp()");
    return this._app;
  }

  // ── Create: rule-aware ──────────────────────────────────────────────────

  async create(opts: CreateComputeOpts): Promise<Compute> {
    // Resolve provider name: explicit `provider` wins, else derive from the
    // compute/runtime pair, else default to "local".
    let providerName: ComputeProviderName | undefined = opts.provider;
    if (!providerName && opts.compute && opts.runtime) {
      providerName = (pairToProvider({ compute: opts.compute, runtime: opts.runtime }) ?? opts.compute) as any;
    }
    providerName = providerName ?? ("local" as ComputeProviderName);

    const provider = this.app.getProvider(providerName);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    // Singleton rule: at most one concrete (non-template, non-clone) row per
    // singleton provider, per tenant. Templates and clones are exempt because
    // templates are blueprints and clones carry `cloned_from` which marks
    // them as ephemeral children of an approved template.
    if (provider.singleton && !opts.is_template && !opts.cloned_from) {
      const existing = await this.computes.findByProvider(providerName, { excludeTemplates: true });
      if (existing) {
        throw new Error(`Provider '${providerName}' is a singleton -- compute '${existing.name}' already exists`);
      }
    }

    // Initial status comes from the provider capability flag. "local" starts
    // "running" (the host is always up); remote providers start "stopped"
    // until `provision()` brings them online.
    const initialStatus = provider.initialStatus as ComputeStatus;

    // Derive compute/runtime axes from explicit opts, falling back to the
    // legacy provider-name mapping (providerToPair).
    const fallback = providerToPair(providerName);
    const compute_kind = (opts.compute ?? fallback.compute) as ComputeKindName;
    const runtime_kind = (opts.runtime ?? fallback.runtime) as RuntimeKindName;

    return this.computes.insert({
      name: opts.name,
      provider: providerName,
      compute_kind,
      runtime_kind,
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

  list(filters?: { status?: ComputeStatus; provider?: ComputeProviderName; limit?: number }): Promise<Compute[]> {
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
    const provider = this.app.getProvider(row.provider);
    if (provider && provider.canDelete === false) {
      throw new Error(`Provider '${row.provider}' does not support deletion`);
    }
    return this.computes.delete(name);
  }
}
