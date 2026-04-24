/**
 * Git-and-manifest-derived signals for the code-intel store:
 *   - Dependencies (from manifest files)
 *   - People (deduped commit authors)
 *   - Contributions (per-person, per-repo or per-file aggregates)
 *   - Hotspots (change-frequency risk scores)
 *
 * These four tables feed the ownership + risk views. They share no schema
 * but cluster cohesively: every row here is produced by a git-history or
 * manifest extractor and consumed by the same ownership queries.
 */

import { randomUUID } from "crypto";
import { TABLE as DEPS_TABLE } from "../schema/dependencies.js";
import { TABLE as PEOPLE_TABLE } from "../schema/people.js";
import { TABLE as CONTRIB_TABLE } from "../schema/contributions.js";
import { TABLE as HOTSPOTS_TABLE } from "../schema/file-hotspots.js";
import { StoreDialect } from "./dialect.js";
import {
  jsonParse,
  jsonStringify,
  nowIso,
  type ContributionRow,
  type DependencyRow,
  type HotspotRow,
  type PersonRow,
} from "./types.js";

export class DependenciesRepo extends StoreDialect {
  async insertDependency(input: {
    id?: string;
    tenant_id: string;
    repo_id: string;
    file_id?: string | null;
    manifest_kind: string;
    name: string;
    version_constraint?: string | null;
    resolved_version?: string | null;
    dep_type?: "prod" | "dev" | "peer" | "optional";
    indexing_run_id: string;
  }): Promise<DependencyRow> {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const dep_type = input.dep_type ?? "prod";
    await this.db
      .prepare(
        `INSERT INTO ${DEPS_TABLE} (id, tenant_id, repo_id, file_id, manifest_kind, name, version_constraint, resolved_version, dep_type, indexing_run_id, created_at)
         VALUES (${this.phs(1, 11)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.repo_id,
        input.file_id ?? null,
        input.manifest_kind,
        input.name,
        input.version_constraint ?? null,
        input.resolved_version ?? null,
        dep_type,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      repo_id: input.repo_id,
      file_id: input.file_id ?? null,
      manifest_kind: input.manifest_kind,
      name: input.name,
      version_constraint: input.version_constraint ?? null,
      resolved_version: input.resolved_version ?? null,
      dep_type,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  async listDependencies(tenant_id: string, repo_id: string): Promise<DependencyRow[]> {
    return (await this.db
      .prepare(
        `SELECT * FROM ${DEPS_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)} AND deleted_at IS NULL ORDER BY manifest_kind, name`,
      )
      .all(tenant_id, repo_id)) as DependencyRow[];
  }
}

export class PeopleRepo extends StoreDialect {
  async upsertPerson(input: {
    id?: string;
    tenant_id: string;
    primary_email: string;
    name?: string | null;
    alt_emails?: string[];
    alt_names?: string[];
  }): Promise<PersonRow> {
    const existing = (await this.db
      .prepare(
        `SELECT id, tenant_id, primary_email, name, alt_emails, alt_names, created_at FROM ${PEOPLE_TABLE}
         WHERE tenant_id = ${this.ph(1)} AND primary_email = ${this.ph(2)}`,
      )
      .get(input.tenant_id, input.primary_email)) as
      | (Omit<PersonRow, "alt_emails" | "alt_names"> & { alt_emails: string; alt_names: string })
      | undefined;
    if (existing) {
      return {
        ...existing,
        alt_emails: jsonParse(existing.alt_emails, [] as string[]),
        alt_names: jsonParse(existing.alt_names, [] as string[]),
      };
    }
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const alt_emails = input.alt_emails ?? [];
    const alt_names = input.alt_names ?? [];
    await this.db
      .prepare(
        `INSERT INTO ${PEOPLE_TABLE} (id, tenant_id, primary_email, name, alt_emails, alt_names, created_at) VALUES (${this.phs(1, 7)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.primary_email,
        input.name ?? null,
        jsonStringify(alt_emails),
        jsonStringify(alt_names),
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      primary_email: input.primary_email,
      name: input.name ?? null,
      alt_emails,
      alt_names,
      created_at,
    };
  }

  async listPeople(tenant_id: string): Promise<PersonRow[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, primary_email, name, alt_emails, alt_names, created_at FROM ${PEOPLE_TABLE} WHERE tenant_id = ${this.ph(1)} ORDER BY name`,
      )
      .all(tenant_id)) as Array<
      Omit<PersonRow, "alt_emails" | "alt_names"> & { alt_emails: string; alt_names: string }
    >;
    return rows.map((r) => ({
      ...r,
      alt_emails: jsonParse(r.alt_emails, [] as string[]),
      alt_names: jsonParse(r.alt_names, [] as string[]),
    }));
  }
}

export class ContributionsRepo extends StoreDialect {
  async insertContribution(input: {
    id?: string;
    tenant_id: string;
    person_id: string;
    repo_id: string;
    file_id?: string | null;
    commit_count?: number;
    loc_added?: number;
    loc_removed?: number;
    first_commit?: string | null;
    last_commit?: string | null;
    indexing_run_id: string;
  }): Promise<ContributionRow> {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const commit_count = input.commit_count ?? 0;
    const loc_added = input.loc_added ?? 0;
    const loc_removed = input.loc_removed ?? 0;
    await this.db
      .prepare(
        `INSERT INTO ${CONTRIB_TABLE} (id, tenant_id, person_id, repo_id, file_id, commit_count, loc_added, loc_removed, first_commit, last_commit, indexing_run_id, created_at)
         VALUES (${this.phs(1, 12)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.person_id,
        input.repo_id,
        input.file_id ?? null,
        commit_count,
        loc_added,
        loc_removed,
        input.first_commit ?? null,
        input.last_commit ?? null,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      person_id: input.person_id,
      repo_id: input.repo_id,
      file_id: input.file_id ?? null,
      commit_count,
      loc_added,
      loc_removed,
      first_commit: input.first_commit ?? null,
      last_commit: input.last_commit ?? null,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  async listContributionsForRepo(tenant_id: string, repo_id: string, limit = 100): Promise<ContributionRow[]> {
    return (await this.db
      .prepare(
        `SELECT * FROM ${CONTRIB_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)} AND file_id IS NULL AND deleted_at IS NULL
         ORDER BY commit_count DESC LIMIT ${this.ph(3)}`,
      )
      .all(tenant_id, repo_id, limit)) as ContributionRow[];
  }

  async listContributionsForFile(tenant_id: string, file_id: string, limit = 20): Promise<ContributionRow[]> {
    return (await this.db
      .prepare(
        `SELECT * FROM ${CONTRIB_TABLE} WHERE tenant_id = ${this.ph(1)} AND file_id = ${this.ph(2)} AND deleted_at IS NULL
         ORDER BY commit_count DESC LIMIT ${this.ph(3)}`,
      )
      .all(tenant_id, file_id, limit)) as ContributionRow[];
  }
}

export class HotspotsRepo extends StoreDialect {
  async insertHotspot(input: {
    id?: string;
    tenant_id: string;
    file_id: string;
    change_count_30d: number;
    change_count_90d: number;
    authors_count: number;
    lines_touched: number;
    risk_score: number;
    indexing_run_id: string;
  }): Promise<HotspotRow> {
    const id = input.id ?? randomUUID();
    const computed_at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO ${HOTSPOTS_TABLE} (id, tenant_id, file_id, change_count_30d, change_count_90d, authors_count, lines_touched, risk_score, computed_at, indexing_run_id)
         VALUES (${this.phs(1, 10)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.file_id,
        input.change_count_30d,
        input.change_count_90d,
        input.authors_count,
        input.lines_touched,
        input.risk_score,
        computed_at,
        input.indexing_run_id,
      );
    return { ...input, id, computed_at, deleted_at: null };
  }

  async getHotspotForFile(tenant_id: string, file_id: string): Promise<HotspotRow | null> {
    const row = (await this.db
      .prepare(
        `SELECT * FROM ${HOTSPOTS_TABLE} WHERE tenant_id = ${this.ph(1)} AND file_id = ${this.ph(2)} AND deleted_at IS NULL ORDER BY computed_at DESC LIMIT 1`,
      )
      .get(tenant_id, file_id)) as HotspotRow | undefined;
    return row ?? null;
  }
}
