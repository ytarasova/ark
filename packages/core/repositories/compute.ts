import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type {
  Compute,
  ComputeStatus,
  ComputeProviderName,
  ComputeKindName,
  RuntimeKindName,
  ComputeConfig,
} from "../../types/index.js";
import { providerToPair } from "../../compute/adapters/provider-map.js";
import { now } from "../util/time.js";

// -- Insert contract ------------------------------------------------------

/**
 * Input to {@link ComputeRepository.insert}. A fully-resolved row: no
 * defaults, no rules, no kind inference. Callers (typically `ComputeService`)
 * are expected to apply domain rules (singleton, initialStatus, ...) before
 * reaching the repo layer.
 */
export interface InsertComputeRow {
  name: string;
  provider: ComputeProviderName;
  compute_kind: ComputeKindName;
  runtime_kind: RuntimeKindName;
  status: ComputeStatus;
  config?: Partial<ComputeConfig>;
  is_template?: boolean;
  cloned_from?: string | null;
}

// -- Row type (config stored as JSON string) ------------------------------

type DrizzleSelectCompute = {
  name: string;
  provider: string;
  computeKind: string | null;
  runtimeKind: string | null;
  status: string;
  config: string | null;
  isTemplate: number | boolean | null;
  clonedFrom: string | null;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
};

// -- Helpers --------------------------------------------------------------

function safeParseConfig(raw: unknown): ComputeConfig {
  if (typeof raw === "object" && raw !== null) return raw as ComputeConfig;
  try {
    return JSON.parse(String(raw ?? "{}"));
  } catch {
    return {};
  }
}

function rowToCompute(row: DrizzleSelectCompute): Compute {
  const fallback = providerToPair(row.provider);
  const compute_kind = (row.computeKind as ComputeKindName | undefined | null) ?? fallback.compute;
  const runtime_kind = (row.runtimeKind as RuntimeKindName | undefined | null) ?? fallback.runtime;
  return {
    name: row.name,
    provider: row.provider as ComputeProviderName,
    compute_kind: compute_kind as ComputeKindName,
    runtime_kind: runtime_kind as RuntimeKindName,
    status: row.status as ComputeStatus,
    config: safeParseConfig(row.config),
    is_template: !!row.isTemplate,
    cloned_from: row.clonedFrom ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  } as Compute;
}

// -- Repository -----------------------------------------------------------

/**
 * ComputeRepository -- dialect-parameterized persistence for compute rows.
 *
 * This layer is intentionally dumb: no domain rules (singleton, canDelete,
 * initialStatus) are enforced here. Those rules belong to `ComputeService`,
 * which consults the provider registry and then calls `insert` / `delete`
 * with fully-resolved inputs. Keeping the repo free of rule logic lets the
 * hosted (ControlPlane) store be swapped in without re-implementing every
 * rule above the storage boundary.
 */
export class ComputeRepository {
  private tenantId: string = "default";
  private _d: DrizzleClient | null = null;

  constructor(private db: DatabaseAdapter) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  setTenant(tenantId: string): void {
    this.tenantId = tenantId;
  }
  getTenant(): string {
    return this.tenantId;
  }

  /**
   * Dumb write: persist the row as given, with no rule enforcement.
   * Caller is responsible for resolving provider/compute/runtime kinds and
   * computing initial status via the provider registry.
   */
  async insert(row: InsertComputeRow): Promise<Compute> {
    const ts = now();
    const d = this.d();
    await (d.db as any).insert(d.schema.compute).values({
      name: row.name,
      provider: row.provider,
      computeKind: row.compute_kind,
      runtimeKind: row.runtime_kind,
      status: row.status,
      config: JSON.stringify(row.config ?? {}),
      isTemplate: !!row.is_template as any,
      clonedFrom: row.cloned_from ?? null,
      tenantId: this.tenantId,
      createdAt: ts,
      updatedAt: ts,
    });
    return (await this.get(row.name))!;
  }

  /**
   * Single-row lookup by provider name. Used by `ComputeService` to enforce
   * the singleton rule. `excludeTemplates` skips rows where `is_template`
   * is true (templates are blueprints, not concrete instances).
   */
  async findByProvider(
    providerName: ComputeProviderName,
    opts?: { excludeTemplates?: boolean },
  ): Promise<Compute | null> {
    const d = this.d();
    const c = d.schema.compute;
    const conditions: any[] = [eq(c.provider, providerName), eq(c.tenantId, this.tenantId)];
    if (opts?.excludeTemplates) {
      // NOT is_template compiled across dialects: SQLite stores 0/1 integer,
      // Postgres stores boolean. `eq(c.isTemplate, false as any)` works for
      // both because drizzle's codec maps `false` -> 0 on SQLite.
      conditions.push(eq(c.isTemplate, false as any));
    }
    const rows = await (d.db as any)
      .select()
      .from(c)
      .where(and(...conditions))
      .limit(1);
    const row = (rows as DrizzleSelectCompute[])[0];
    return row ? rowToCompute(row) : null;
  }

  async get(name: string): Promise<Compute | null> {
    const d = this.d();
    const c = d.schema.compute;
    const rows = await (d.db as any)
      .select()
      .from(c)
      .where(and(eq(c.name, name), eq(c.tenantId, this.tenantId)))
      .limit(1);
    const row = (rows as DrizzleSelectCompute[])[0];
    return row ? rowToCompute(row) : null;
  }

  async list(filters?: { status?: ComputeStatus; provider?: ComputeProviderName; limit?: number }): Promise<Compute[]> {
    const d = this.d();
    const c = d.schema.compute;
    const conditions: any[] = [eq(c.tenantId, this.tenantId)];
    if (filters?.provider) conditions.push(eq(c.provider, filters.provider));
    if (filters?.status) conditions.push(eq(c.status, filters.status));
    const rows = await (d.db as any)
      .select()
      .from(c)
      .where(and(...conditions))
      .orderBy(desc(c.createdAt))
      .limit(filters?.limit ?? 100);
    return (rows as DrizzleSelectCompute[]).map(rowToCompute);
  }

  /** Filter view: rows that are reusable config blueprints. */
  async listTemplates(): Promise<Compute[]> {
    const d = this.d();
    const c = d.schema.compute;
    const rows = await (d.db as any)
      .select()
      .from(c)
      .where(and(eq(c.tenantId, this.tenantId), eq(c.isTemplate, true as any)))
      .orderBy(desc(c.createdAt));
    return (rows as DrizzleSelectCompute[]).map(rowToCompute);
  }

  /** Filter view: rows that are concrete (non-template) compute targets. */
  async listConcrete(): Promise<Compute[]> {
    const d = this.d();
    const c = d.schema.compute;
    const rows = await (d.db as any)
      .select()
      .from(c)
      .where(and(eq(c.tenantId, this.tenantId), eq(c.isTemplate, false as any)))
      .orderBy(desc(c.createdAt));
    return (rows as DrizzleSelectCompute[]).map(rowToCompute);
  }

  async update(name: string, fields: Partial<Compute>): Promise<Compute | null> {
    const d = this.d();
    const c = d.schema.compute;

    const set: Record<string, any> = { updatedAt: now() };
    if (fields.provider !== undefined) set.provider = fields.provider;
    if (fields.compute_kind !== undefined) set.computeKind = fields.compute_kind;
    if (fields.runtime_kind !== undefined) set.runtimeKind = fields.runtime_kind;
    if (fields.status !== undefined) set.status = fields.status;
    if (fields.config !== undefined) {
      set.config =
        typeof fields.config === "object" && fields.config !== null ? JSON.stringify(fields.config) : fields.config;
    }
    if ((fields as any).is_template !== undefined) set.isTemplate = !!(fields as any).is_template as any;
    if ((fields as any).cloned_from !== undefined) set.clonedFrom = (fields as any).cloned_from ?? null;

    await (d.db as any)
      .update(c)
      .set(set)
      .where(and(eq(c.name, name), eq(c.tenantId, this.tenantId)));
    return this.get(name);
  }

  async delete(name: string): Promise<boolean> {
    const d = this.d();
    const c = d.schema.compute;
    const res = await (d.db as any).delete(c).where(and(eq(c.name, name), eq(c.tenantId, this.tenantId)));
    return extractChangesLocal(res) > 0;
  }

  async mergeConfig(name: string, patch: Partial<ComputeConfig>): Promise<Compute | null> {
    // Stay inside DatabaseAdapter.transaction for SQL portability. Inside the
    // transaction we read with drizzle (both drivers share the same raw
    // connection for SQLite; Postgres uses its pool but pg is serializable
    // on the row we're touching so the race window stays narrow).
    await this.db.transaction(async () => {
      const existing = await this.get(name);
      if (!existing) return;
      const merged = { ...(existing.config ?? {}), ...patch };
      const d = this.d();
      const c = d.schema.compute;
      await (d.db as any)
        .update(c)
        .set({ config: JSON.stringify(merged), updatedAt: new Date().toISOString() })
        .where(and(eq(c.name, name), eq(c.tenantId, this.tenantId)));
    });
    return this.get(name);
  }
}

function extractChangesLocal(res: unknown): number {
  if (!res || typeof res !== "object") return 0;
  const r = res as { changes?: number; rowCount?: number; count?: number };
  if (typeof r.changes === "number") return r.changes;
  if (typeof r.rowCount === "number") return r.rowCount;
  if (typeof r.count === "number") return r.count;
  return 0;
}

// Silence unused imports in case a future edit drops sql/ne usage:
void sql;
void ne;
