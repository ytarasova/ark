/**
 * Chunk CRUD + FTS search for the code-intel store.
 *
 * Chunks are the unit the retriever returns. SQLite keeps a parallel fts5
 * contentless table (`code_intel_chunks_fts`) updated on every insert;
 * Postgres uses a generated `tsvector` column on the base table and needs
 * no secondary write.
 */

import { randomUUID } from "crypto";
import { TABLE as CHUNKS_TABLE, FTS_TABLE as CHUNKS_FTS_TABLE } from "../schema/chunks.js";
import type { ChunkKind } from "../interfaces/types.js";
import { StoreDialect } from "./dialect.js";
import { jsonParse, jsonStringify, nowIso, sanitizeFtsQuery, type ChunkRow } from "./types.js";

export class ChunksRepo extends StoreDialect {
  async insertChunk(input: {
    id?: string;
    tenant_id: string;
    file_id: string;
    symbol_id?: string | null;
    parent_chunk_id?: string | null;
    chunk_kind?: ChunkKind;
    content: string;
    line_start?: number | null;
    line_end?: number | null;
    attrs?: Record<string, unknown>;
    indexing_run_id: string;
    /** Optional FTS hints (path + symbol name) so search matches file paths + symbol names. */
    path_hint?: string;
    symbol_name?: string;
  }): Promise<ChunkRow> {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const chunk_kind = input.chunk_kind ?? "code";
    const attrs = input.attrs ?? {};
    await this.db
      .prepare(
        `INSERT INTO ${CHUNKS_TABLE} (id, tenant_id, file_id, symbol_id, parent_chunk_id, chunk_kind, content, line_start, line_end, attrs, indexing_run_id, created_at)
         VALUES (${this.phs(1, 12)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.file_id,
        input.symbol_id ?? null,
        input.parent_chunk_id ?? null,
        chunk_kind,
        input.content,
        input.line_start ?? null,
        input.line_end ?? null,
        jsonStringify(attrs),
        input.indexing_run_id,
        created_at,
      );
    // SQLite FTS insert (content-linked table). Postgres uses generated tsvector
    // in the base table already; nothing to do there.
    if (this.dialect === "sqlite") {
      await this.db
        .prepare(
          `INSERT INTO ${CHUNKS_FTS_TABLE} (chunk_id, tenant_id, content, path_hint, symbol_name) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, input.tenant_id, input.content, input.path_hint ?? "", input.symbol_name ?? "");
    }
    return {
      id,
      tenant_id: input.tenant_id,
      file_id: input.file_id,
      symbol_id: input.symbol_id ?? null,
      parent_chunk_id: input.parent_chunk_id ?? null,
      chunk_kind,
      content: input.content,
      line_start: input.line_start ?? null,
      line_end: input.line_end ?? null,
      attrs,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  async getChunk(tenant_id: string, id: string): Promise<ChunkRow | null> {
    const row = (await this.db
      .prepare(
        `SELECT id, tenant_id, file_id, symbol_id, parent_chunk_id, chunk_kind, content, line_start, line_end, attrs, indexing_run_id, created_at, deleted_at
         FROM ${CHUNKS_TABLE} WHERE tenant_id = ${this.ph(1)} AND id = ${this.ph(2)} AND deleted_at IS NULL`,
      )
      .get(tenant_id, id)) as (Omit<ChunkRow, "attrs"> & { attrs: string }) | undefined;
    return row ? { ...row, attrs: jsonParse(row.attrs, {}) } : null;
  }

  async listChunksByFile(tenant_id: string, file_id: string): Promise<ChunkRow[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, file_id, symbol_id, parent_chunk_id, chunk_kind, content, line_start, line_end, attrs, indexing_run_id, created_at, deleted_at
         FROM ${CHUNKS_TABLE} WHERE tenant_id = ${this.ph(1)} AND file_id = ${this.ph(2)} AND deleted_at IS NULL ORDER BY line_start ASC`,
      )
      .all(tenant_id, file_id)) as Array<Omit<ChunkRow, "attrs"> & { attrs: string }>;
    return rows.map((r) => ({ ...r, attrs: jsonParse(r.attrs, {}) }));
  }

  /**
   * Simple FTS over chunks. SQLite uses fts5 MATCH; Postgres falls back to
   * plainto_tsquery against the generated tsvector column.
   */
  async searchChunks(tenant_id: string, query: string, limit = 50): Promise<Array<ChunkRow & { match_score: number }>> {
    if (this.dialect === "sqlite") {
      const rows = (await this.db
        .prepare(
          `SELECT c.id, c.tenant_id, c.file_id, c.symbol_id, c.parent_chunk_id, c.chunk_kind, c.content, c.line_start, c.line_end, c.attrs, c.indexing_run_id, c.created_at, c.deleted_at, bm25(${CHUNKS_FTS_TABLE}) AS match_score
           FROM ${CHUNKS_FTS_TABLE} f JOIN ${CHUNKS_TABLE} c ON c.id = f.chunk_id
           WHERE f.tenant_id = ? AND ${CHUNKS_FTS_TABLE} MATCH ? AND c.deleted_at IS NULL
           ORDER BY match_score ASC LIMIT ?`,
        )
        .all(tenant_id, sanitizeFtsQuery(query), limit)) as Array<
        Omit<ChunkRow, "attrs"> & { attrs: string; match_score: number }
      >;
      return rows.map((r) => ({ ...r, attrs: jsonParse(r.attrs, {}) }));
    }
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, file_id, symbol_id, parent_chunk_id, chunk_kind, content, line_start, line_end, attrs, indexing_run_id, created_at, deleted_at,
                ts_rank(fts_tsv, plainto_tsquery('english', $2)) AS match_score
         FROM ${CHUNKS_TABLE}
         WHERE tenant_id = $1 AND fts_tsv @@ plainto_tsquery('english', $2) AND deleted_at IS NULL
         ORDER BY match_score DESC LIMIT $3`,
      )
      .all(tenant_id, query, limit)) as Array<Omit<ChunkRow, "attrs"> & { attrs: string; match_score: number }>;
    return rows.map((r) => ({ ...r, attrs: jsonParse(r.attrs, {}) }));
  }
}
