/**
 * Workspace CRUD + repo-workspace attachment for the code-intel store.
 *
 * A workspace is a tenant-scoped bundle of repos that share platform docs.
 * Attach/detach mutates `repos.workspace_id`; soft-delete refuses to cascade
 * unless `force: true` is passed, in which case attached repos are detached
 * first and then the workspace row is soft-deleted inside one transaction.
 */

import { randomUUID } from "crypto";
import { TABLE as WORKSPACES_TABLE } from "../schema/workspaces.js";
import { TABLE as REPOS_TABLE } from "../schema/repos.js";
import { StoreDialect } from "./dialect.js";
import { jsonParse, jsonStringify, nowIso, type Repo, type Workspace } from "./types.js";

export class WorkspacesRepo extends StoreDialect {
  async createWorkspace(input: {
    id?: string;
    tenant_id: string;
    slug: string;
    name: string;
    description?: string | null;
    config?: Record<string, unknown>;
  }): Promise<Workspace> {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const description = input.description ?? null;
    const config = input.config ?? {};
    await this.db
      .prepare(
        `INSERT INTO ${WORKSPACES_TABLE} (id, tenant_id, slug, name, description, config, created_at)
         VALUES (${this.phs(1, 7)})`,
      )
      .run(id, input.tenant_id, input.slug, input.name, description, jsonStringify(config), created_at);
    return {
      id,
      tenant_id: input.tenant_id,
      slug: input.slug,
      name: input.name,
      description,
      config,
      created_at,
      deleted_at: null,
    };
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const row = (await this.db
      .prepare(
        `SELECT id, tenant_id, slug, name, description, config, created_at, deleted_at
         FROM ${WORKSPACES_TABLE} WHERE id = ${this.ph(1)} AND deleted_at IS NULL`,
      )
      .get(id)) as (Omit<Workspace, "config"> & { config: string }) | undefined;
    return row ? { ...row, config: jsonParse(row.config, {}) } : null;
  }

  async getWorkspaceBySlug(tenant_id: string, slug: string): Promise<Workspace | null> {
    const row = (await this.db
      .prepare(
        `SELECT id, tenant_id, slug, name, description, config, created_at, deleted_at
         FROM ${WORKSPACES_TABLE} WHERE tenant_id = ${this.ph(1)} AND slug = ${this.ph(2)} AND deleted_at IS NULL`,
      )
      .get(tenant_id, slug)) as (Omit<Workspace, "config"> & { config: string }) | undefined;
    return row ? { ...row, config: jsonParse(row.config, {}) } : null;
  }

  async listWorkspaces(tenant_id: string): Promise<Workspace[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, slug, name, description, config, created_at, deleted_at
         FROM ${WORKSPACES_TABLE} WHERE tenant_id = ${this.ph(1)} AND deleted_at IS NULL ORDER BY slug ASC`,
      )
      .all(tenant_id)) as Array<Omit<Workspace, "config"> & { config: string }>;
    return rows.map((r) => ({ ...r, config: jsonParse(r.config, {}) }));
  }

  /**
   * Soft-delete a workspace. Does not cascade to repos. If any repo still
   * points at the workspace, the call throws unless `force: true` is passed;
   * with `force`, repos are detached (`workspace_id = NULL`) and the
   * workspace is marked deleted.
   */
  async softDeleteWorkspace(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const attached = (await this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${REPOS_TABLE} WHERE workspace_id = ${this.ph(1)} AND deleted_at IS NULL`)
      .get(id)) as { n: number } | undefined;
    const attachedCount = attached?.n ?? 0;
    if (attachedCount > 0 && !opts.force) {
      throw new Error(
        `workspace ${id} still has ${attachedCount} attached repo(s); pass {force: true} to detach + delete`,
      );
    }
    const now = nowIso();
    await this.db.transaction(async () => {
      if (attachedCount > 0) {
        await this.db
          .prepare(`UPDATE ${REPOS_TABLE} SET workspace_id = NULL WHERE workspace_id = ${this.ph(1)}`)
          .run(id);
      }
      await this.db
        .prepare(`UPDATE ${WORKSPACES_TABLE} SET deleted_at = ${this.ph(1)} WHERE id = ${this.ph(2)}`)
        .run(now, id);
    });
  }

  /** Attach a repo to a workspace. Both must belong to the same tenant. */
  async addRepoToWorkspace(repo_id: string, workspace_id: string): Promise<void> {
    const repo = (await this.db
      .prepare(`SELECT tenant_id FROM ${REPOS_TABLE} WHERE id = ${this.ph(1)}`)
      .get(repo_id)) as { tenant_id: string } | undefined;
    if (!repo) throw new Error(`repo ${repo_id} not found`);
    const ws = (await this.db
      .prepare(`SELECT tenant_id FROM ${WORKSPACES_TABLE} WHERE id = ${this.ph(1)} AND deleted_at IS NULL`)
      .get(workspace_id)) as { tenant_id: string } | undefined;
    if (!ws) throw new Error(`workspace ${workspace_id} not found`);
    if (repo.tenant_id !== ws.tenant_id) {
      throw new Error(`repo and workspace belong to different tenants`);
    }
    await this.db
      .prepare(`UPDATE ${REPOS_TABLE} SET workspace_id = ${this.ph(1)} WHERE id = ${this.ph(2)}`)
      .run(workspace_id, repo_id);
  }

  /** Detach a repo from whatever workspace currently owns it. */
  async removeRepoFromWorkspace(repo_id: string): Promise<void> {
    await this.db.prepare(`UPDATE ${REPOS_TABLE} SET workspace_id = NULL WHERE id = ${this.ph(1)}`).run(repo_id);
  }

  /** Return `workspace_id` for a repo (null if unattached or unknown). */
  async getRepoWorkspaceId(repo_id: string): Promise<string | null> {
    const row = (await this.db
      .prepare(`SELECT workspace_id FROM ${REPOS_TABLE} WHERE id = ${this.ph(1)}`)
      .get(repo_id)) as { workspace_id: string | null } | undefined;
    return row?.workspace_id ?? null;
  }

  /** List repos attached to a workspace. Tenant-scoped to belt-and-braces. */
  async listReposInWorkspace(tenant_id: string, workspace_id: string): Promise<Repo[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at, deleted_at
         FROM ${REPOS_TABLE} WHERE tenant_id = ${this.ph(1)} AND workspace_id = ${this.ph(2)} AND deleted_at IS NULL
         ORDER BY name ASC`,
      )
      .all(tenant_id, workspace_id)) as Array<Omit<Repo, "config"> & { config: string }>;
    return rows.map((r) => ({ ...r, config: jsonParse(r.config, {}) }));
  }
}
