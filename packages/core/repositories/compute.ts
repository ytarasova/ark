import type { IDatabase } from "../database/index.js";
import type {
  Compute,
  ComputeStatus,
  ComputeProviderName,
  ComputeKindName,
  RuntimeKindName,
  ComputeConfig,
  CreateComputeOpts,
} from "../../types/index.js";
import { providerToPair, pairToProvider } from "../../compute/adapters/provider-map.js";
import { now } from "../util/time.js";

// -- Row type (config stored as JSON string) ------------------------------

interface ComputeRow {
  name: string;
  provider: string;
  compute_kind?: string | null;
  runtime_kind?: string | null;
  status: string;
  config: string;
  is_template?: number | boolean | null;
  cloned_from?: string | null;
  created_at: string;
  updated_at: string;
}

// -- Helpers --------------------------------------------------------------

function safeParseConfig(raw: unknown): ComputeConfig {
  if (typeof raw === "object" && raw !== null) return raw as ComputeConfig;
  try {
    return JSON.parse(String(raw ?? "{}"));
  } catch {
    return {};
  }
}

function rowToCompute(row: ComputeRow): Compute {
  // Legacy rows may not carry compute_kind/runtime_kind -- fall back via the
  // provider-map so every consumer sees both axes regardless of row age.
  const fallback = providerToPair(row.provider);
  const compute_kind = (row.compute_kind as ComputeKindName | undefined | null) ?? fallback.compute;
  const runtime_kind = (row.runtime_kind as RuntimeKindName | undefined | null) ?? fallback.runtime;
  return {
    ...row,
    provider: row.provider as ComputeProviderName,
    compute_kind: compute_kind as ComputeKindName,
    runtime_kind: runtime_kind as RuntimeKindName,
    status: row.status as ComputeStatus,
    config: safeParseConfig(row.config),
    is_template: !!row.is_template,
    cloned_from: row.cloned_from ?? null,
  };
}

// Valid compute columns (from schema).
const COMPUTE_COLUMNS = new Set([
  "provider",
  "compute_kind",
  "runtime_kind",
  "status",
  "config",
  "is_template",
  "cloned_from",
  "updated_at",
]);

// Providers that allow only one compute instance per tenant.
const SINGLETON_PROVIDERS = new Set(["local"]);

// -- Repository -----------------------------------------------------------

export class ComputeRepository {
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

  setTenant(tenantId: string): void {
    this.tenantId = tenantId;
  }
  getTenant(): string {
    return this.tenantId;
  }

  async create(opts: CreateComputeOpts): Promise<Compute> {
    const ts = now();

    // When caller passes the new axes (`compute`, `runtime`) without a
    // legacy `provider`, reverse-map to the best legacy name so back-compat
    // reads (`compute.provider`) keep working and the singleton check below
    // uses the correct key.
    let provider = opts.provider;
    if (!provider && opts.compute && opts.runtime) {
      provider = (pairToProvider({ compute: opts.compute, runtime: opts.runtime }) ?? opts.compute) as any;
    }
    provider = provider ?? "local";

    // Singleton providers allow only one *concrete* instance per tenant.
    // Templates are blueprints and never run on real infra, so they're
    // exempt; likewise clones are per-session ephemeral rows. The
    // constraint only matters for concrete rows that model real hardware.
    if (SINGLETON_PROVIDERS.has(provider) && !opts.is_template && !opts.cloned_from) {
      const existing = (await this.db
        .prepare("SELECT name FROM compute WHERE provider = ? AND tenant_id = ? AND NOT is_template")
        .get(provider, this.tenantId)) as { name: string } | undefined;
      if (existing) {
        throw new Error(`Provider '${provider}' is a singleton -- compute '${existing.name}' already exists`);
      }
    }

    const initialStatus: ComputeStatus = provider === "local" ? "running" : "stopped";

    // Derive compute_kind + runtime_kind. Callers may pass the new axes
    // explicitly; otherwise we compute them from the legacy provider name.
    const fallback = providerToPair(provider);
    const computeKind = (opts.compute ?? fallback.compute) as ComputeKindName;
    const runtimeKind = (opts.runtime ?? fallback.runtime) as RuntimeKindName;

    // SQLite stores booleans as 0/1; Postgres uses BOOLEAN. Pass a JS
    // boolean and let each driver encode appropriately. rowToCompute
    // normalizes back to a TS boolean on read.
    const isTemplate = !!opts.is_template;
    const clonedFrom = opts.cloned_from ?? null;

    await this.db
      .prepare(
        `
      INSERT INTO compute (name, provider, compute_kind, runtime_kind, status, config, is_template, cloned_from, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        opts.name,
        provider,
        computeKind,
        runtimeKind,
        initialStatus,
        JSON.stringify(opts.config ?? {}),
        isTemplate,
        clonedFrom,
        this.tenantId,
        ts,
        ts,
      );

    return (await this.get(opts.name))!;
  }

  async get(name: string): Promise<Compute | null> {
    const row = (await this.db
      .prepare("SELECT * FROM compute WHERE name = ? AND tenant_id = ?")
      .get(name, this.tenantId)) as ComputeRow | undefined;
    if (!row) return null;
    return rowToCompute(row);
  }

  async list(filters?: { status?: ComputeStatus; provider?: ComputeProviderName; limit?: number }): Promise<Compute[]> {
    let sql = "SELECT * FROM compute WHERE tenant_id = ?";
    const params: any[] = [this.tenantId];

    if (filters?.provider) {
      sql += " AND provider = ?";
      params.push(filters.provider);
    }
    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(filters?.limit ?? 100);

    return ((await this.db.prepare(sql).all(...params)) as ComputeRow[]).map(rowToCompute);
  }

  /** Filter view: rows that are reusable config blueprints. */
  async listTemplates(): Promise<Compute[]> {
    const rows = (await this.db
      .prepare("SELECT * FROM compute WHERE tenant_id = ? AND is_template ORDER BY created_at DESC")
      .all(this.tenantId)) as ComputeRow[];
    return rows.map(rowToCompute);
  }

  /** Filter view: rows that are concrete (non-template) compute targets. */
  async listConcrete(): Promise<Compute[]> {
    const rows = (await this.db
      .prepare("SELECT * FROM compute WHERE tenant_id = ? AND NOT is_template ORDER BY created_at DESC")
      .all(this.tenantId)) as ComputeRow[];
    return rows.map(rowToCompute);
  }

  async update(name: string, fields: Partial<Compute>): Promise<Compute | null> {
    const updates: string[] = ["updated_at = ?"];
    const values: any[] = [now()];

    for (const [key, value] of Object.entries(fields)) {
      if (key === "name" || key === "created_at") continue;
      if (!COMPUTE_COLUMNS.has(key)) continue;
      if (key === "config" && typeof value === "object") {
        updates.push("config = ?");
        values.push(JSON.stringify(value));
      } else {
        updates.push(`${key} = ?`);
        values.push(value ?? null);
      }
    }
    values.push(name, this.tenantId);

    await this.db.prepare(`UPDATE compute SET ${updates.join(", ")} WHERE name = ? AND tenant_id = ?`).run(...values);
    return this.get(name);
  }

  async delete(name: string): Promise<boolean> {
    if (name === "local") return false;
    const result = await this.db
      .prepare("DELETE FROM compute WHERE name = ? AND tenant_id = ?")
      .run(name, this.tenantId);
    return result.changes > 0;
  }

  async mergeConfig(name: string, patch: Partial<ComputeConfig>): Promise<Compute | null> {
    await this.db.transaction(async () => {
      const row = (await this.db
        .prepare("SELECT config FROM compute WHERE name = ? AND tenant_id = ?")
        .get(name, this.tenantId)) as { config: string } | undefined;
      if (!row) return;
      const existing = safeParseConfig(row.config);
      const merged = { ...existing, ...patch };
      await this.db
        .prepare("UPDATE compute SET config = ?, updated_at = ? WHERE name = ? AND tenant_id = ?")
        .run(JSON.stringify(merged), new Date().toISOString(), name, this.tenantId);
    });
    return this.get(name);
  }
}
