/**
 * WorkspaceStore -- minimal multi-repo workspace storage.
 *
 * Tables (created by migration 014):
 *   - workspaces       (id, tenant_id, slug, name, description, config, ...)
 *   - workspace_repos  (id, tenant_id, repo_url, name, default_branch,
 *                       primary_language, local_path, workspace_id, ...)
 *
 * `workspace_repos` is the per-workspace repo table -- one row per repo,
 * with a nullable `workspace_id` FK so a repo can be detached without
 * deletion. Tenant-scoped on every read.
 */

import { randomUUID } from "crypto";
import type { DatabaseAdapter } from "../core/database/index.js";
import type { Repo, Workspace } from "./types.js";

export const WORKSPACES_TABLE = "workspaces";
export const REPOS_TABLE = "workspace_repos";

function nowIso(): string {
  return new Date().toISOString();
}

function jsonStringify(v: unknown): string {
  return JSON.stringify(v ?? {});
}

function jsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export class WorkspaceStore {
  constructor(private readonly db: DatabaseAdapter) {}

  // ── Workspaces ───────────────────────────────────────────────────────────

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
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
         FROM ${WORKSPACES_TABLE} WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(id)) as (Omit<Workspace, "config"> & { config: string }) | undefined;
    return row ? { ...row, config: jsonParse(row.config, {}) } : null;
  }

  async getWorkspaceBySlug(tenant_id: string, slug: string): Promise<Workspace | null> {
    const row = (await this.db
      .prepare(
        `SELECT id, tenant_id, slug, name, description, config, created_at, deleted_at
         FROM ${WORKSPACES_TABLE} WHERE tenant_id = ? AND slug = ? AND deleted_at IS NULL`,
      )
      .get(tenant_id, slug)) as (Omit<Workspace, "config"> & { config: string }) | undefined;
    return row ? { ...row, config: jsonParse(row.config, {}) } : null;
  }

  async listWorkspaces(tenant_id: string): Promise<Workspace[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, slug, name, description, config, created_at, deleted_at
         FROM ${WORKSPACES_TABLE} WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY slug ASC`,
      )
      .all(tenant_id)) as Array<Omit<Workspace, "config"> & { config: string }>;
    return rows.map((r) => ({ ...r, config: jsonParse(r.config, {}) }));
  }

  /**
   * Soft-delete a workspace. Refuses if any repo is still attached unless
   * `force: true` is passed (in which case repos are detached first).
   */
  async softDeleteWorkspace(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const attached = (await this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${REPOS_TABLE} WHERE workspace_id = ? AND deleted_at IS NULL`)
      .get(id)) as { n: number } | undefined;
    const attachedCount = attached?.n ?? 0;
    if (attachedCount > 0 && !opts.force) {
      throw new Error(
        `workspace ${id} still has ${attachedCount} attached repo(s); pass {force: true} to detach + delete`,
      );
    }
    const now = nowIso();
    if (attachedCount > 0) {
      await this.db.prepare(`UPDATE ${REPOS_TABLE} SET workspace_id = NULL WHERE workspace_id = ?`).run(id);
    }
    await this.db.prepare(`UPDATE ${WORKSPACES_TABLE} SET deleted_at = ? WHERE id = ?`).run(now, id);
  }

  // ── Repos ────────────────────────────────────────────────────────────────

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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  async getRepo(tenant_id: string, repo_id: string): Promise<Repo | null> {
    const row = (await this.db
      .prepare(
        `SELECT id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at, deleted_at
         FROM ${REPOS_TABLE} WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      )
      .get(repo_id, tenant_id)) as (Omit<Repo, "config"> & { config: string }) | undefined;
    return row ? { ...row, config: jsonParse(row.config, {}) } : null;
  }

  async listRepos(tenant_id: string): Promise<Repo[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at, deleted_at
         FROM ${REPOS_TABLE} WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name ASC`,
      )
      .all(tenant_id)) as Array<Omit<Repo, "config"> & { config: string }>;
    return rows.map((r) => ({ ...r, config: jsonParse(r.config, {}) }));
  }

  // ── Workspace <-> Repo attachment ────────────────────────────────────────

  /** Attach a repo to a workspace. Both must belong to the same tenant. */
  async addRepoToWorkspace(repo_id: string, workspace_id: string): Promise<void> {
    const repo = (await this.db.prepare(`SELECT tenant_id FROM ${REPOS_TABLE} WHERE id = ?`).get(repo_id)) as
      | { tenant_id: string }
      | undefined;
    if (!repo) throw new Error(`repo ${repo_id} not found`);
    const ws = (await this.db
      .prepare(`SELECT tenant_id FROM ${WORKSPACES_TABLE} WHERE id = ? AND deleted_at IS NULL`)
      .get(workspace_id)) as { tenant_id: string } | undefined;
    if (!ws) throw new Error(`workspace ${workspace_id} not found`);
    if (repo.tenant_id !== ws.tenant_id) {
      throw new Error("repo and workspace belong to different tenants");
    }
    await this.db.prepare(`UPDATE ${REPOS_TABLE} SET workspace_id = ? WHERE id = ?`).run(workspace_id, repo_id);
  }

  /** Detach a repo from whatever workspace currently owns it. */
  async removeRepoFromWorkspace(repo_id: string): Promise<void> {
    await this.db.prepare(`UPDATE ${REPOS_TABLE} SET workspace_id = NULL WHERE id = ?`).run(repo_id);
  }

  /** Return `workspace_id` for a repo (null if unattached or unknown). */
  async getRepoWorkspaceId(repo_id: string): Promise<string | null> {
    const row = (await this.db.prepare(`SELECT workspace_id FROM ${REPOS_TABLE} WHERE id = ?`).get(repo_id)) as
      | { workspace_id: string | null }
      | undefined;
    return row?.workspace_id ?? null;
  }

  /** List repos attached to a workspace. Tenant-scoped to belt-and-braces. */
  async listReposInWorkspace(tenant_id: string, workspace_id: string): Promise<Repo[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at, deleted_at
         FROM ${REPOS_TABLE}
         WHERE tenant_id = ? AND workspace_id = ? AND deleted_at IS NULL
         ORDER BY name ASC`,
      )
      .all(tenant_id, workspace_id)) as Array<Omit<Repo, "config"> & { config: string }>;
    return rows.map((r) => ({ ...r, config: jsonParse(r.config, {}) }));
  }
}
