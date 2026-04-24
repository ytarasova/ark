/**
 * Repo CRUD for the code-intel store.
 *
 * Repos belong to a tenant and are the unit of indexing. Soft-delete is
 * respected on every read path.
 */

import { randomUUID } from "crypto";
import { TABLE as REPOS_TABLE } from "../schema/repos.js";
import { StoreDialect } from "./dialect.js";
import { jsonParse, jsonStringify, nowIso, type Repo } from "./types.js";

export class ReposRepo extends StoreDialect {
  async createRepo(input: {
    id?: string;
    tenant_id: string;
    repo_url: string;
    name: string;
    default_branch?: string;
    primary_language?: string | null;
    local_path?: string | null;
    config?: Record<string, unknown>;
  }): Promise<Repo> {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const default_branch = input.default_branch ?? "main";
    const config = input.config ?? {};
    await this.db
      .prepare(
        `INSERT INTO ${REPOS_TABLE} (id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at)
         VALUES (${this.phs(1, 9)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.repo_url,
        input.name,
        default_branch,
        input.primary_language ?? null,
        input.local_path ?? null,
        jsonStringify(config),
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      repo_url: input.repo_url,
      name: input.name,
      default_branch,
      primary_language: input.primary_language ?? null,
      local_path: input.local_path ?? null,
      config,
      created_at,
      deleted_at: null,
    };
  }

  async getRepo(tenant_id: string, id: string): Promise<Repo | null> {
    const row = (await this.db
      .prepare(
        `SELECT id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at, deleted_at
         FROM ${REPOS_TABLE} WHERE tenant_id = ${this.ph(1)} AND id = ${this.ph(2)} AND deleted_at IS NULL`,
      )
      .get(tenant_id, id)) as (Omit<Repo, "config"> & { config: string }) | undefined;
    return row ? { ...row, config: jsonParse(row.config, {}) } : null;
  }

  async findRepoByUrl(tenant_id: string, repo_url: string): Promise<Repo | null> {
    const row = (await this.db
      .prepare(
        `SELECT id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at, deleted_at
         FROM ${REPOS_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_url = ${this.ph(2)} AND deleted_at IS NULL`,
      )
      .get(tenant_id, repo_url)) as (Omit<Repo, "config"> & { config: string }) | undefined;
    return row ? { ...row, config: jsonParse(row.config, {}) } : null;
  }

  async listRepos(tenant_id: string): Promise<Repo[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at, deleted_at
         FROM ${REPOS_TABLE} WHERE tenant_id = ${this.ph(1)} AND deleted_at IS NULL ORDER BY name ASC`,
      )
      .all(tenant_id)) as Array<Omit<Repo, "config"> & { config: string }>;
    return rows.map((r) => ({ ...r, config: jsonParse(r.config, {}) }));
  }

  async softDeleteRepo(tenant_id: string, id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE ${REPOS_TABLE} SET deleted_at = ${this.ph(1)} WHERE tenant_id = ${this.ph(2)} AND id = ${this.ph(3)}`,
      )
      .run(nowIso(), tenant_id, id);
  }
}
