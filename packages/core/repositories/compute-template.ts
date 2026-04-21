import type { IDatabase } from "../database/index.js";
import type { ComputeTemplate, ComputeProviderName, ComputeConfig } from "../../types/index.js";
import { now } from "../util/time.js";

interface TemplateRow {
  name: string;
  description: string | null;
  provider: string;
  config: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
}

function rowToTemplate(row: TemplateRow): ComputeTemplate {
  return {
    name: row.name,
    description: row.description ?? undefined,
    provider: row.provider as ComputeProviderName,
    config: JSON.parse(row.config || "{}") as Partial<ComputeConfig>,
    tenant_id: row.tenant_id,
  };
}

export class ComputeTemplateRepository {
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

  setTenant(id: string): void {
    this.tenantId = id;
  }

  async list(): Promise<ComputeTemplate[]> {
    const rows = (await this.db
      .prepare("SELECT * FROM compute_templates WHERE tenant_id = ? ORDER BY name")
      .all(this.tenantId)) as TemplateRow[];
    return rows.map(rowToTemplate);
  }

  async get(name: string): Promise<ComputeTemplate | null> {
    const row = (await this.db
      .prepare("SELECT * FROM compute_templates WHERE name = ? AND tenant_id = ?")
      .get(name, this.tenantId)) as TemplateRow | undefined;
    return row ? rowToTemplate(row) : null;
  }

  async create(template: ComputeTemplate): Promise<void> {
    const ts = now();
    await this.db
      .prepare(
        "INSERT INTO compute_templates (name, description, provider, config, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        template.name,
        template.description ?? null,
        template.provider,
        JSON.stringify(template.config),
        this.tenantId,
        ts,
        ts,
      );
  }

  async update(
    name: string,
    fields: Partial<Pick<ComputeTemplate, "description" | "provider" | "config">>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: any[] = [];
    if (fields.description !== undefined) {
      sets.push("description = ?");
      params.push(fields.description);
    }
    if (fields.provider !== undefined) {
      sets.push("provider = ?");
      params.push(fields.provider);
    }
    if (fields.config !== undefined) {
      sets.push("config = ?");
      params.push(JSON.stringify(fields.config));
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(now());
    params.push(name, this.tenantId);
    await this.db
      .prepare(`UPDATE compute_templates SET ${sets.join(", ")} WHERE name = ? AND tenant_id = ?`)
      .run(...params);
  }

  async delete(name: string): Promise<void> {
    await this.db.prepare("DELETE FROM compute_templates WHERE name = ? AND tenant_id = ?").run(name, this.tenantId);
  }
}
