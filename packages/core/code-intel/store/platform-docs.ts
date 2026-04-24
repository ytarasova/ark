/**
 * Platform docs + version-history CRUD for the code-intel store.
 *
 * `upsertPlatformDoc()` maintains an immutable snapshot timeline
 * (`platform_doc_versions`) alongside the soft-deleted `platform_docs`
 * rows so diff/timeline queries walk one monotonic version axis per
 * (workspace_id, doc_type).
 */

import { randomUUID } from "crypto";
import { TABLE as PLATFORM_DOCS_TABLE } from "../schema/platform-docs.js";
import { TABLE as PLATFORM_DOC_VERSIONS_TABLE } from "../schema/platform-doc-versions.js";
import type { PlatformDocFlavor } from "../interfaces/platform-doc-extractor.js";
import { StoreDialect } from "./dialect.js";
import { jsonParse, jsonStringify, nowIso, type PlatformDoc, type PlatformDocVersion } from "./types.js";

export class PlatformDocsRepo extends StoreDialect {
  /**
   * Insert-or-replace a platform doc for (workspace_id, doc_type).
   *
   * Executes atomically in one transaction:
   *   1. Read the currently-active row (if any) + the highest-ever version
   *      for this (workspace_id, doc_type) tuple across *all* past rows
   *      (active or soft-deleted), so `version` monotonically increases.
   *   2. Soft-delete the previous active row, if any.
   *   3. Insert the new `platform_docs` row.
   *   4. Append a snapshot to `platform_doc_versions`.
   *
   * Wave 4 (LLM-synthesized) + Wave 5 (hybrid) docs use the exact same
   * path; they just pass `generated_by: 'llm' | 'hybrid'` plus a `model`
   * and an optional `generated_from_run_id`.
   */
  async upsertPlatformDoc(input: {
    id?: string;
    tenant_id: string;
    workspace_id: string;
    doc_type: string;
    title: string;
    content_md: string;
    source?: Record<string, unknown>;
    generated_by?: PlatformDocFlavor;
    generated_from_run_id?: string | null;
    model?: string | null;
  }): Promise<PlatformDoc> {
    const id = input.id ?? randomUUID();
    const generated_at = nowIso();
    const source = input.source ?? {};
    const generated_by = input.generated_by ?? "mechanical";
    const generated_from_run_id = input.generated_from_run_id ?? null;
    const model = input.model ?? null;

    let created: PlatformDoc | null = null;
    await this.db.transaction(async () => {
      // Find the previous active row (there can be at most one live per
      // workspace/doc_type thanks to the partial unique index).
      const previousActive = (await this.db
        .prepare(
          `SELECT id FROM ${PLATFORM_DOCS_TABLE}
           WHERE workspace_id = ${this.ph(1)} AND doc_type = ${this.ph(2)} AND deleted_at IS NULL`,
        )
        .get(input.workspace_id, input.doc_type)) as { id: string } | undefined;

      // Determine the next version by walking all past rows for this
      // (workspace_id, doc_type) -- including soft-deleted ones -- and
      // taking max(version)+1.
      const versionRow = (await this.db
        .prepare(
          `SELECT COALESCE(MAX(v.version), 0) AS max_version
             FROM ${PLATFORM_DOCS_TABLE} d
             LEFT JOIN ${PLATFORM_DOC_VERSIONS_TABLE} v ON v.doc_id = d.id
             WHERE d.workspace_id = ${this.ph(1)} AND d.doc_type = ${this.ph(2)}`,
        )
        .get(input.workspace_id, input.doc_type)) as { max_version: number | null } | undefined;
      const nextVersion = (versionRow?.max_version ?? 0) + 1;

      // Soft-delete the previous active row so the partial unique index
      // stays satisfied for the new insert.
      if (previousActive) {
        await this.db
          .prepare(`UPDATE ${PLATFORM_DOCS_TABLE} SET deleted_at = ${this.ph(1)} WHERE id = ${this.ph(2)}`)
          .run(generated_at, previousActive.id);
      }

      // Insert the new active row.
      await this.db
        .prepare(
          `INSERT INTO ${PLATFORM_DOCS_TABLE}
             (id, tenant_id, workspace_id, doc_type, title, content_md, source, generated_by, generated_from_run_id, model, generated_at)
           VALUES (${this.phs(1, 11)})`,
        )
        .run(
          id,
          input.tenant_id,
          input.workspace_id,
          input.doc_type,
          input.title,
          input.content_md,
          jsonStringify(source),
          generated_by,
          generated_from_run_id,
          model,
          generated_at,
        );

      // Append an immutable version snapshot.
      await this.db
        .prepare(
          `INSERT INTO ${PLATFORM_DOC_VERSIONS_TABLE} (id, doc_id, version, content_md, generated_at)
           VALUES (${this.phs(1, 5)})`,
        )
        .run(randomUUID(), id, nextVersion, input.content_md, generated_at);

      created = {
        id,
        tenant_id: input.tenant_id,
        workspace_id: input.workspace_id,
        doc_type: input.doc_type,
        title: input.title,
        content_md: input.content_md,
        source,
        generated_by,
        generated_from_run_id,
        model,
        generated_at,
        deleted_at: null,
      };
    });
    return created!;
  }

  /** Get the currently-active doc for a (workspace_id, doc_type). */
  async getPlatformDoc(workspace_id: string, doc_type: string): Promise<PlatformDoc | null> {
    const row = (await this.db
      .prepare(
        `SELECT id, tenant_id, workspace_id, doc_type, title, content_md, source, generated_by, generated_from_run_id, model, generated_at, deleted_at
           FROM ${PLATFORM_DOCS_TABLE}
           WHERE workspace_id = ${this.ph(1)} AND doc_type = ${this.ph(2)} AND deleted_at IS NULL
           LIMIT 1`,
      )
      .get(workspace_id, doc_type)) as (Omit<PlatformDoc, "source"> & { source: string }) | undefined;
    return row ? { ...row, source: jsonParse(row.source, {}) } : null;
  }

  /** List every active doc in a workspace, ordered by doc_type for determinism. */
  async listPlatformDocs(workspace_id: string): Promise<PlatformDoc[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, workspace_id, doc_type, title, content_md, source, generated_by, generated_from_run_id, model, generated_at, deleted_at
           FROM ${PLATFORM_DOCS_TABLE}
           WHERE workspace_id = ${this.ph(1)} AND deleted_at IS NULL
           ORDER BY doc_type ASC`,
      )
      .all(workspace_id)) as Array<Omit<PlatformDoc, "source"> & { source: string }>;
    return rows.map((r) => ({ ...r, source: jsonParse(r.source, {}) }));
  }

  /**
   * List every version of the docs associated with `doc_id` -- meaning the
   * full immutable snapshot history of the *doc row* itself (NOT the whole
   * workspace/doc_type timeline; use `listDocVersionsByType` for that).
   */
  async listDocVersions(doc_id: string): Promise<PlatformDocVersion[]> {
    return (await this.db
      .prepare(
        `SELECT id, doc_id, version, content_md, generated_at
           FROM ${PLATFORM_DOC_VERSIONS_TABLE}
           WHERE doc_id = ${this.ph(1)}
           ORDER BY version ASC`,
      )
      .all(doc_id)) as PlatformDocVersion[];
  }

  /**
   * Full version timeline for a (workspace_id, doc_type) across every row
   * (active + soft-deleted). This is what `ark code-intel docs diff` uses
   * to compare arbitrary versions: because `version` is globally
   * monotonically increasing per (workspace_id, doc_type), a single walk
   * over every `platform_docs` row for the key pairs their snapshots up.
   */
  async listDocVersionsByType(workspace_id: string, doc_type: string): Promise<PlatformDocVersion[]> {
    return (await this.db
      .prepare(
        `SELECT v.id, v.doc_id, v.version, v.content_md, v.generated_at
           FROM ${PLATFORM_DOC_VERSIONS_TABLE} v
           JOIN ${PLATFORM_DOCS_TABLE} d ON d.id = v.doc_id
           WHERE d.workspace_id = ${this.ph(1)} AND d.doc_type = ${this.ph(2)}
           ORDER BY v.version ASC`,
      )
      .all(workspace_id, doc_type)) as PlatformDocVersion[];
  }

  /** Fetch one specific snapshot of a doc by `doc_id` + `version`. */
  async getDocVersion(doc_id: string, version: number): Promise<PlatformDocVersion | null> {
    const row = (await this.db
      .prepare(
        `SELECT id, doc_id, version, content_md, generated_at
           FROM ${PLATFORM_DOC_VERSIONS_TABLE}
           WHERE doc_id = ${this.ph(1)} AND version = ${this.ph(2)}`,
      )
      .get(doc_id, version)) as PlatformDocVersion | undefined;
    return row ?? null;
  }
}
