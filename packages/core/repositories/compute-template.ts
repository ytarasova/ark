/**
 * ComputeTemplateRepository -- thin adapter over ComputeRepository.
 *
 * Templates and concrete compute targets now share the same `compute` table,
 * distinguished only by the `is_template` flag. This adapter preserves the
 * legacy shape (`app.computeTemplates.*`, `compute-template/*` RPC handlers,
 * `ark compute template *` CLI subcommands) so callers don't have to change
 * while we collapse the surfaces upstream.
 *
 * Methods delegate to ComputeRepository. The adapter accepts the template
 * shape and translates to/from the unified `Compute` row.
 *
 * System templates: seed data (`config.computeTemplates`) is stored under
 * the sentinel `tenant_id = '__system__'`. Every tenant-scoped read
 * (`list`, `get`) unions the system tenant's templates with the caller's
 * tenant's templates, so hosted deployments see the seeded blueprints from
 * every tenant without duplicating rows. Writes always target the adapter's
 * bound tenant -- a tenant can override a system template by creating one
 * of the same name under their own tenant_id.
 */

import type { DatabaseAdapter } from "../database/index.js";
import type { ComputeProviderName, ComputeConfig, ComputeKindName, IsolationKindName } from "../../types/index.js";
import { providerToPair, pairToProvider } from "../compute/adapters/provider-map.js";
import { ComputeRepository } from "./compute.js";

/** Sentinel tenant for system-wide compute templates seeded at boot. */
export const SYSTEM_TENANT_ID = "__system__";

/** Reusable compute configuration preset. Backed by a `compute` row with `is_template: true`. */
export interface ComputeTemplateView {
  name: string;
  description?: string;
  provider: ComputeProviderName;
  config: Partial<ComputeConfig>;
  tenant_id?: string;
}

function computeToTemplate(c: {
  name: string;
  compute_kind: ComputeKindName;
  isolation_kind: IsolationKindName;
  config: ComputeConfig;
  description?: string | null;
}): ComputeTemplateView {
  return {
    name: c.name,
    description: (c as { description?: string | null }).description ?? undefined,
    provider: (pairToProvider({ compute: c.compute_kind, isolation: c.isolation_kind }) ??
      c.compute_kind) as ComputeProviderName,
    config: c.config as Partial<ComputeConfig>,
  };
}

export class ComputeTemplateRepository {
  private inner: ComputeRepository;
  /** Shadow the inner repo's bound tenant so we can pivot to the system
   *  sentinel for the union read without touching the caller-facing repo. */
  private tenantId: string = "default";
  private systemInner: ComputeRepository;

  constructor(private db: DatabaseAdapter) {
    this.inner = new ComputeRepository(db);
    this.systemInner = new ComputeRepository(db);
    this.systemInner.setTenant(SYSTEM_TENANT_ID);
  }

  setTenant(id: string): void {
    this.tenantId = id;
    this.inner.setTenant(id);
  }

  async list(): Promise<ComputeTemplateView[]> {
    const rows = await this.inner.listTemplates();
    const tenantNames = new Set(rows.map((r) => r.name));
    // System templates are visible to every tenant. Per-tenant rows shadow
    // system rows of the same name (tenant override wins).
    const systemRows =
      this.tenantId === SYSTEM_TENANT_ID
        ? []
        : (await this.systemInner.listTemplates()).filter((r) => !tenantNames.has(r.name));
    return [...rows.map(computeToTemplate), ...systemRows.map(computeToTemplate)];
  }

  async get(name: string): Promise<ComputeTemplateView | null> {
    const row = await this.inner.get(name);
    if (row) return computeToTemplate(row);
    // Fall through to system tenant for seeded blueprints.
    if (this.tenantId !== SYSTEM_TENANT_ID) {
      const sys = await this.systemInner.get(name);
      if (sys && sys.is_template) return computeToTemplate(sys);
    }
    return null;
  }

  async create(template: ComputeTemplateView): Promise<void> {
    // Tolerate older callers that JSON.stringify'd the config before
    // handing it to us (the previous repository wrote a string column).
    const cfg =
      typeof (template as { config?: unknown }).config === "string"
        ? safeParse((template as unknown as { config: string }).config)
        : ((template.config ?? {}) as Partial<ComputeConfig>);

    const provider = (template.provider ?? "local") as ComputeProviderName;
    const pair = providerToPair(provider);

    // Templates are blueprints, not concrete instances, so they're exempt
    // from the singleton rule and the provider-driven initialStatus. Write
    // directly via `insert` rather than routing through `ComputeService`,
    // which would look up a provider this adapter doesn't need.
    await this.inner.insert({
      name: template.name,
      compute_kind: pair.compute as ComputeKindName,
      isolation_kind: pair.isolation as IsolationKindName,
      status: "stopped",
      config: cfg,
      is_template: true,
    });
  }

  async update(
    name: string,
    fields: Partial<Pick<ComputeTemplateView, "description" | "provider" | "config">>,
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (fields.provider !== undefined) patch.provider = fields.provider;
    if (fields.config !== undefined) patch.config = fields.config;
    // `description` has no column in the unified compute table -- we drop
    // it on the floor for now. Callers that need it should switch to the
    // unified `compute/*` RPC family (which also lacks a description today).
    if (Object.keys(patch).length === 0) return;
    await this.inner.update(name, patch);
  }

  async delete(name: string): Promise<void> {
    await this.inner.delete(name);
  }
}

function safeParse(s: string): Partial<ComputeConfig> {
  try {
    return JSON.parse(s) as Partial<ComputeConfig>;
  } catch {
    return {};
  }
}
