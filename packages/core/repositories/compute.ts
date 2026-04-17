import type { IDatabase } from "../database/index.js";
import type {
  Compute,
  ComputeStatus,
  ComputeProviderName,
  ComputeConfig,
  CreateComputeOpts,
} from "../../types/index.js";
import { now } from "../util/time.js";

// ── Row type (config stored as JSON string) ─────────────────────────────────

interface ComputeRow {
  name: string;
  provider: string;
  status: string;
  config: string;
  created_at: string;
  updated_at: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeParseConfig(raw: unknown): ComputeConfig {
  if (typeof raw === "object" && raw !== null) return raw as ComputeConfig;
  try {
    return JSON.parse(String(raw ?? "{}"));
  } catch {
    return {};
  }
}

function rowToCompute(row: ComputeRow): Compute {
  return {
    ...row,
    provider: row.provider as ComputeProviderName,
    status: row.status as ComputeStatus,
    config: safeParseConfig(row.config),
  };
}

// Valid compute columns (from schema).
const COMPUTE_COLUMNS = new Set(["provider", "status", "config", "updated_at"]);

// Providers that allow only one compute instance per tenant.
const SINGLETON_PROVIDERS = new Set(["local"]);

// ── Repository ──────────────────────────────────────────────────────────────

export class ComputeRepository {
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

  setTenant(tenantId: string): void {
    this.tenantId = tenantId;
  }
  getTenant(): string {
    return this.tenantId;
  }

  create(opts: CreateComputeOpts): Compute {
    const ts = now();
    const provider = opts.provider ?? "local";

    // Singleton providers allow only one compute instance per tenant.
    if (SINGLETON_PROVIDERS.has(provider)) {
      const existing = this.db
        .prepare("SELECT name FROM compute WHERE provider = ? AND tenant_id = ?")
        .get(provider, this.tenantId) as { name: string } | undefined;
      if (existing) {
        throw new Error(`Provider '${provider}' is a singleton -- compute '${existing.name}' already exists`);
      }
    }

    const initialStatus: ComputeStatus = provider === "local" ? "running" : "stopped";

    this.db
      .prepare(
        `
      INSERT INTO compute (name, provider, status, config, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(opts.name, provider, initialStatus, JSON.stringify(opts.config ?? {}), this.tenantId, ts, ts);

    return this.get(opts.name)!;
  }

  get(name: string): Compute | null {
    const row = this.db.prepare("SELECT * FROM compute WHERE name = ? AND tenant_id = ?").get(name, this.tenantId) as
      | ComputeRow
      | undefined;
    if (!row) return null;
    return rowToCompute(row);
  }

  list(filters?: { status?: ComputeStatus; provider?: ComputeProviderName; limit?: number }): Compute[] {
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

    return (this.db.prepare(sql).all(...params) as ComputeRow[]).map(rowToCompute);
  }

  update(name: string, fields: Partial<Compute>): Compute | null {
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

    this.db.prepare(`UPDATE compute SET ${updates.join(", ")} WHERE name = ? AND tenant_id = ?`).run(...values);
    return this.get(name);
  }

  delete(name: string): boolean {
    if (name === "local") return false;
    const result = this.db.prepare("DELETE FROM compute WHERE name = ? AND tenant_id = ?").run(name, this.tenantId);
    return result.changes > 0;
  }

  mergeConfig(name: string, patch: Partial<ComputeConfig>): Compute | null {
    this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT config FROM compute WHERE name = ? AND tenant_id = ?")
        .get(name, this.tenantId) as { config: string } | undefined;
      if (!row) return;
      const existing = safeParseConfig(row.config);
      const merged = { ...existing, ...patch };
      this.db
        .prepare("UPDATE compute SET config = ?, updated_at = ? WHERE name = ? AND tenant_id = ?")
        .run(JSON.stringify(merged), new Date().toISOString(), name, this.tenantId);
    });
    return this.get(name);
  }
}
