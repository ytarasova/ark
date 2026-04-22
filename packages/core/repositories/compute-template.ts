/**
 * ComputeTemplateRepository -- thin adapter over ComputeRepository.
 *
 * Templates and concrete compute targets now share the same `compute` table,
 * distinguished only by the `is_template` flag. This adapter preserves the
 * legacy shape (`app.computeTemplates.*`, `compute-template/*` RPC handlers,
 * `ark compute template *` CLI subcommands) so callers don't have to change
 * while we collapse the surfaces upstream.
 *
 * Methods delegate to ComputeRepository. The adapter accepts the legacy
 * `ComputeTemplate` shape and translates to/from the unified `Compute` row.
 */

import type { DatabaseAdapter } from "../database/index.js";
import type {
  ComputeTemplate,
  ComputeProviderName,
  ComputeConfig,
  ComputeKindName,
  RuntimeKindName,
} from "../../types/index.js";
import { providerToPair } from "../../compute/adapters/provider-map.js";
import { ComputeRepository } from "./compute.js";

function computeToTemplate(c: {
  name: string;
  provider: ComputeProviderName;
  config: ComputeConfig;
  description?: string | null;
}): ComputeTemplate {
  return {
    name: c.name,
    description: (c as { description?: string | null }).description ?? undefined,
    provider: c.provider,
    config: c.config as Partial<ComputeConfig>,
  };
}

export class ComputeTemplateRepository {
  private inner: ComputeRepository;

  constructor(db: DatabaseAdapter) {
    this.inner = new ComputeRepository(db);
  }

  setTenant(id: string): void {
    this.inner.setTenant(id);
  }

  async list(): Promise<ComputeTemplate[]> {
    const rows = await this.inner.listTemplates();
    return rows.map((r) => computeToTemplate(r));
  }

  async get(name: string): Promise<ComputeTemplate | null> {
    const row = await this.inner.get(name);
    if (!row) return null;
    return computeToTemplate(row);
  }

  async create(template: ComputeTemplate): Promise<void> {
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
      provider,
      compute_kind: pair.compute as ComputeKindName,
      runtime_kind: pair.runtime as RuntimeKindName,
      status: "stopped",
      config: cfg,
      is_template: true,
    });
  }

  async update(
    name: string,
    fields: Partial<Pick<ComputeTemplate, "description" | "provider" | "config">>,
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
