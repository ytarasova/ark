/**
 * Tenant CRUD for the code-intel store.
 *
 * Tenants are the outermost scope; every other row in the schema carries a
 * `tenant_id`. There is no soft-delete for tenants in Wave 1.
 */

import { randomUUID } from "crypto";
import { TABLE as TENANTS_TABLE } from "../schema/tenants.js";
import { StoreDialect } from "./dialect.js";
import { nowIso, type Tenant } from "./types.js";

export class TenantsRepo extends StoreDialect {
  async createTenant(input: { id?: string; name: string; slug: string }): Promise<Tenant> {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    await this.db
      .prepare(`INSERT INTO ${TENANTS_TABLE} (id, name, slug, created_at) VALUES (${this.phs(1, 4)})`)
      .run(id, input.name, input.slug, created_at);
    return { id, name: input.name, slug: input.slug, created_at };
  }

  async getTenant(id: string): Promise<Tenant | null> {
    const row = (await this.db
      .prepare(`SELECT id, name, slug, created_at FROM ${TENANTS_TABLE} WHERE id = ${this.ph(1)}`)
      .get(id)) as Tenant | undefined;
    return row ?? null;
  }

  async getTenantBySlug(slug: string): Promise<Tenant | null> {
    const row = (await this.db
      .prepare(`SELECT id, name, slug, created_at FROM ${TENANTS_TABLE} WHERE slug = ${this.ph(1)}`)
      .get(slug)) as Tenant | undefined;
    return row ?? null;
  }

  async listTenants(): Promise<Tenant[]> {
    return (await this.db
      .prepare(`SELECT id, name, slug, created_at FROM ${TENANTS_TABLE} ORDER BY created_at ASC`)
      .all()) as Tenant[];
  }
}
