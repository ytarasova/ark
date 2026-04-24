/**
 * Indexing-run lifecycle for the code-intel store.
 *
 * `beginIndexingRun()` + `finalizeIndexingRun()` bracket a reindex. Finalize
 * atomically marks the run done + soft-deletes every prior active row tagged
 * to a different run for this (tenant, repo), so queries can rely on the
 * latest ok run being the sole "live" state.
 */

import { randomUUID } from "crypto";
import { TABLE as RUNS_TABLE } from "../schema/indexing-runs.js";
import { TABLE as FILES_TABLE } from "../schema/files.js";
import { TABLE as SYMBOLS_TABLE } from "../schema/symbols.js";
import { TABLE as CHUNKS_TABLE } from "../schema/chunks.js";
import { TABLE as EDGES_TABLE } from "../schema/edges.js";
import { TABLE as DEPS_TABLE } from "../schema/dependencies.js";
import { TABLE as CONTRIB_TABLE } from "../schema/contributions.js";
import { TABLE as HOTSPOTS_TABLE } from "../schema/file-hotspots.js";
import { StoreDialect } from "./dialect.js";
import { jsonParse, jsonStringify, nowIso, type IndexingRun } from "./types.js";

export class IndexingRunsRepo extends StoreDialect {
  async beginIndexingRun(input: {
    id?: string;
    tenant_id: string;
    repo_id: string;
    branch: string;
    commit_sha?: string | null;
  }): Promise<IndexingRun> {
    const id = input.id ?? randomUUID();
    const started_at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO ${RUNS_TABLE} (id, tenant_id, repo_id, branch, commit_sha, status, extractor_counts, started_at)
         VALUES (${this.phs(1, 8)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.repo_id,
        input.branch,
        input.commit_sha ?? null,
        "running",
        jsonStringify({}),
        started_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      repo_id: input.repo_id,
      branch: input.branch,
      commit_sha: input.commit_sha ?? null,
      status: "running",
      extractor_counts: {},
      error_msg: null,
      started_at,
      finished_at: null,
    };
  }

  /**
   * Finalize a run: mark status + soft-delete every prior active row tagged
   * to a different run for this (tenant, repo). This makes the new run the
   * sole "live" state atomically from the query surface's point of view.
   */
  async finalizeIndexingRun(input: {
    run_id: string;
    status: "ok" | "error" | "cancelled";
    extractor_counts?: Record<string, number>;
    error_msg?: string | null;
  }): Promise<void> {
    const finished_at = nowIso();
    await this.db.transaction(async () => {
      await this.db
        .prepare(
          `UPDATE ${RUNS_TABLE} SET status = ${this.ph(1)}, finished_at = ${this.ph(2)}, extractor_counts = ${this.ph(3)}, error_msg = ${this.ph(4)} WHERE id = ${this.ph(5)}`,
        )
        .run(
          input.status,
          finished_at,
          jsonStringify(input.extractor_counts ?? {}),
          input.error_msg ?? null,
          input.run_id,
        );

      if (input.status !== "ok") return;

      // Find the run we just finalized to identify its (tenant, repo).
      const run = (await this.db
        .prepare(`SELECT tenant_id, repo_id FROM ${RUNS_TABLE} WHERE id = ${this.ph(1)}`)
        .get(input.run_id)) as { tenant_id: string; repo_id: string } | undefined;
      if (!run) return;

      // Tables we soft-delete to let the latest run win. `embeddings` and
      // `external_refs` don't carry deleted_at; leave them alone.
      const tables = [FILES_TABLE, SYMBOLS_TABLE, CHUNKS_TABLE, EDGES_TABLE, DEPS_TABLE, CONTRIB_TABLE, HOTSPOTS_TABLE];
      // Resolve prior runs once so the inner UPDATE doesn't carry a subquery
      // (subqueries with our placeholder helper would double-count parameters).
      const priorRuns = (await this.db
        .prepare(
          `SELECT id FROM ${RUNS_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)} AND id != ${this.ph(3)}`,
        )
        .all(run.tenant_id, run.repo_id, input.run_id)) as Array<{ id: string }>;
      if (priorRuns.length === 0) return;

      for (const t of tables) {
        // Build a `IN (?, ?, ...)` clause sized to the prior-run count.
        const placeholders = priorRuns.map((_, i) => (this.dialect === "sqlite" ? "?" : `$${i + 3}`)).join(", ");
        const sql = `UPDATE ${t} SET deleted_at = ${this.dialect === "sqlite" ? "?" : "$1"}
             WHERE tenant_id = ${this.dialect === "sqlite" ? "?" : "$2"}
               AND deleted_at IS NULL
               AND indexing_run_id IN (${placeholders})`;
        const params = [finished_at, run.tenant_id, ...priorRuns.map((r) => r.id)];
        await this.db.prepare(sql).run(...params);
      }
    });
  }

  async getIndexingRun(id: string): Promise<IndexingRun | null> {
    const row = (await this.db
      .prepare(
        `SELECT id, tenant_id, repo_id, branch, commit_sha, status, extractor_counts, error_msg, started_at, finished_at
         FROM ${RUNS_TABLE} WHERE id = ${this.ph(1)}`,
      )
      .get(id)) as (Omit<IndexingRun, "extractor_counts"> & { extractor_counts: string }) | undefined;
    return row ? { ...row, extractor_counts: jsonParse(row.extractor_counts, {}) } : null;
  }

  async listIndexingRuns(tenant_id: string, repo_id?: string, limit = 50): Promise<IndexingRun[]> {
    const rows = repo_id
      ? ((await this.db
          .prepare(
            `SELECT id, tenant_id, repo_id, branch, commit_sha, status, extractor_counts, error_msg, started_at, finished_at
             FROM ${RUNS_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)}
             ORDER BY started_at DESC, id DESC LIMIT ${this.ph(3)}`,
          )
          .all(tenant_id, repo_id, limit)) as Array<
          Omit<IndexingRun, "extractor_counts"> & { extractor_counts: string }
        >)
      : ((await this.db
          .prepare(
            `SELECT id, tenant_id, repo_id, branch, commit_sha, status, extractor_counts, error_msg, started_at, finished_at
             FROM ${RUNS_TABLE} WHERE tenant_id = ${this.ph(1)} ORDER BY started_at DESC, id DESC LIMIT ${this.ph(2)}`,
          )
          .all(tenant_id, limit)) as Array<Omit<IndexingRun, "extractor_counts"> & { extractor_counts: string }>);
    return rows.map((r) => ({ ...r, extractor_counts: jsonParse(r.extractor_counts, {}) }));
  }
}
