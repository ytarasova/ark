/**
 * Graph + embedding CRUD for the code-intel store.
 *
 * - Edges: symbol-to-symbol / file-to-symbol / etc. relations, the raw
 *   material for callers/references queries.
 * - External refs: unresolved cross-repo symbol references, resolved during
 *   a later pass.
 * - Embeddings: vector data keyed by (subject_kind, subject_id, model).
 */

import { randomUUID } from "crypto";
import { TABLE as EDGES_TABLE } from "../schema/edges.js";
import { TABLE as EXT_REFS_TABLE } from "../schema/external-refs.js";
import { TABLE as EMBEDDINGS_TABLE } from "../schema/embeddings.js";
import type { EdgeRelation, EntityKind, SubjectKind } from "../interfaces/types.js";
import { StoreDialect } from "./dialect.js";
import { jsonParse, jsonStringify, nowIso, type EdgeRow, type EmbeddingRow, type ExternalRefRow } from "./types.js";

export class EdgesRepo extends StoreDialect {
  async insertEdge(input: {
    id?: string;
    tenant_id: string;
    source_kind: EntityKind;
    source_id: string;
    target_kind: EntityKind;
    target_id: string;
    relation: EdgeRelation;
    evidence_chunk_id?: string | null;
    weight?: number;
    attrs?: Record<string, unknown>;
    indexing_run_id: string;
  }): Promise<EdgeRow> {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    const weight = input.weight ?? 1.0;
    const attrs = input.attrs ?? {};
    await this.db
      .prepare(
        `INSERT INTO ${EDGES_TABLE} (id, tenant_id, source_kind, source_id, target_kind, target_id, relation, evidence_chunk_id, weight, attrs, indexing_run_id, created_at)
         VALUES (${this.phs(1, 12)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.source_kind,
        input.source_id,
        input.target_kind,
        input.target_id,
        input.relation,
        input.evidence_chunk_id ?? null,
        weight,
        jsonStringify(attrs),
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      source_kind: input.source_kind,
      source_id: input.source_id,
      target_kind: input.target_kind,
      target_id: input.target_id,
      relation: input.relation,
      evidence_chunk_id: input.evidence_chunk_id ?? null,
      weight,
      attrs,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  async listEdgesFrom(tenant_id: string, source_kind: EntityKind, source_id: string): Promise<EdgeRow[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, source_kind, source_id, target_kind, target_id, relation, evidence_chunk_id, weight, attrs, indexing_run_id, created_at, deleted_at
         FROM ${EDGES_TABLE} WHERE tenant_id = ${this.ph(1)} AND source_kind = ${this.ph(2)} AND source_id = ${this.ph(3)} AND deleted_at IS NULL`,
      )
      .all(tenant_id, source_kind, source_id)) as Array<Omit<EdgeRow, "attrs"> & { attrs: string }>;
    return rows.map((r) => ({ ...r, attrs: jsonParse(r.attrs, {}) }));
  }

  async listEdgesTo(tenant_id: string, target_kind: EntityKind, target_id: string): Promise<EdgeRow[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, tenant_id, source_kind, source_id, target_kind, target_id, relation, evidence_chunk_id, weight, attrs, indexing_run_id, created_at, deleted_at
         FROM ${EDGES_TABLE} WHERE tenant_id = ${this.ph(1)} AND target_kind = ${this.ph(2)} AND target_id = ${this.ph(3)} AND deleted_at IS NULL`,
      )
      .all(tenant_id, target_kind, target_id)) as Array<Omit<EdgeRow, "attrs"> & { attrs: string }>;
    return rows.map((r) => ({ ...r, attrs: jsonParse(r.attrs, {}) }));
  }
}

export class ExternalRefsRepo extends StoreDialect {
  async insertExternalRef(input: {
    id?: string;
    tenant_id: string;
    symbol_id: string;
    external_repo_hint?: string | null;
    external_fqn: string;
    indexing_run_id: string;
  }): Promise<ExternalRefRow> {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO ${EXT_REFS_TABLE} (id, tenant_id, symbol_id, external_repo_hint, external_fqn, indexing_run_id, created_at)
         VALUES (${this.phs(1, 7)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.symbol_id,
        input.external_repo_hint ?? null,
        input.external_fqn,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      symbol_id: input.symbol_id,
      external_repo_hint: input.external_repo_hint ?? null,
      external_fqn: input.external_fqn,
      resolved_symbol_id: null,
      resolved_at: null,
      indexing_run_id: input.indexing_run_id,
      created_at,
    };
  }

  async listExternalRefs(tenant_id: string, onlyUnresolved = false): Promise<ExternalRefRow[]> {
    const sql = onlyUnresolved
      ? `SELECT * FROM ${EXT_REFS_TABLE} WHERE tenant_id = ${this.ph(1)} AND resolved_symbol_id IS NULL`
      : `SELECT * FROM ${EXT_REFS_TABLE} WHERE tenant_id = ${this.ph(1)}`;
    return (await this.db.prepare(sql).all(tenant_id)) as ExternalRefRow[];
  }
}

export class EmbeddingsRepo extends StoreDialect {
  async insertEmbedding(input: {
    id?: string;
    tenant_id: string;
    subject_kind: SubjectKind;
    subject_id: string;
    model: string;
    model_version: string;
    dim: number;
    vector: Uint8Array;
    indexing_run_id: string;
  }): Promise<EmbeddingRow> {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO ${EMBEDDINGS_TABLE} (id, tenant_id, subject_kind, subject_id, model, model_version, dim, vector, indexing_run_id, created_at)
         VALUES (${this.phs(1, 10)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.subject_kind,
        input.subject_id,
        input.model,
        input.model_version,
        input.dim,
        input.vector,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      model: input.model,
      model_version: input.model_version,
      dim: input.dim,
      vector: input.vector,
      indexing_run_id: input.indexing_run_id,
      created_at,
    };
  }

  async getEmbedding(
    tenant_id: string,
    subject_kind: SubjectKind,
    subject_id: string,
    model: string,
    model_version: string,
  ): Promise<EmbeddingRow | null> {
    const row = (await this.db
      .prepare(
        `SELECT * FROM ${EMBEDDINGS_TABLE} WHERE tenant_id = ${this.ph(1)} AND subject_kind = ${this.ph(2)} AND subject_id = ${this.ph(3)} AND model = ${this.ph(4)} AND model_version = ${this.ph(5)}`,
      )
      .get(tenant_id, subject_kind, subject_id, model, model_version)) as EmbeddingRow | undefined;
    return row ?? null;
  }
}
