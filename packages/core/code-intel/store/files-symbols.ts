/**
 * File + symbol ingestion and read APIs for the code-intel store.
 *
 * Files and symbols are separate tables but always queried together; the
 * extractor pipeline inserts a file then writes its symbols in one pass.
 */

import { randomUUID } from "crypto";
import { TABLE as FILES_TABLE } from "../schema/files.js";
import { TABLE as SYMBOLS_TABLE } from "../schema/symbols.js";
import type { SymbolKind } from "../interfaces/types.js";
import { StoreDialect } from "./dialect.js";
import { nowIso, type FileRow, type SymbolRow } from "./types.js";

export class FilesRepo extends StoreDialect {
  async insertFile(input: {
    id?: string;
    tenant_id: string;
    repo_id: string;
    path: string;
    sha: string;
    mtime?: string | null;
    language?: string | null;
    size_bytes?: number | null;
    indexing_run_id: string;
  }): Promise<FileRow> {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO ${FILES_TABLE} (id, tenant_id, repo_id, path, sha, mtime, language, size_bytes, indexing_run_id, created_at)
         VALUES (${this.phs(1, 10)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.repo_id,
        input.path,
        input.sha,
        input.mtime ?? null,
        input.language ?? null,
        input.size_bytes ?? null,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      repo_id: input.repo_id,
      path: input.path,
      sha: input.sha,
      mtime: input.mtime ?? null,
      language: input.language ?? null,
      size_bytes: input.size_bytes ?? null,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  async getFile(tenant_id: string, id: string): Promise<FileRow | null> {
    const row = (await this.db
      .prepare(
        `SELECT * FROM ${FILES_TABLE} WHERE tenant_id = ${this.ph(1)} AND id = ${this.ph(2)} AND deleted_at IS NULL`,
      )
      .get(tenant_id, id)) as FileRow | undefined;
    return row ?? null;
  }

  async listFiles(tenant_id: string, repo_id: string, limit = 1000): Promise<FileRow[]> {
    return (await this.db
      .prepare(
        `SELECT * FROM ${FILES_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)} AND deleted_at IS NULL
         ORDER BY path ASC LIMIT ${this.ph(3)}`,
      )
      .all(tenant_id, repo_id, limit)) as FileRow[];
  }

  async findFileByPath(tenant_id: string, repo_id: string, path: string): Promise<FileRow | null> {
    const row = (await this.db
      .prepare(
        `SELECT * FROM ${FILES_TABLE} WHERE tenant_id = ${this.ph(1)} AND repo_id = ${this.ph(2)} AND path = ${this.ph(3)} AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(tenant_id, repo_id, path)) as FileRow | undefined;
    return row ?? null;
  }
}

export class SymbolsRepo extends StoreDialect {
  async insertSymbol(input: {
    id?: string;
    tenant_id: string;
    file_id: string;
    kind: SymbolKind;
    name: string;
    fqn?: string | null;
    signature?: string | null;
    line_start?: number | null;
    line_end?: number | null;
    parent_symbol_id?: string | null;
    indexing_run_id: string;
  }): Promise<SymbolRow> {
    const id = input.id ?? randomUUID();
    const created_at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO ${SYMBOLS_TABLE} (id, tenant_id, file_id, kind, name, fqn, signature, line_start, line_end, parent_symbol_id, indexing_run_id, created_at)
         VALUES (${this.phs(1, 12)})`,
      )
      .run(
        id,
        input.tenant_id,
        input.file_id,
        input.kind,
        input.name,
        input.fqn ?? null,
        input.signature ?? null,
        input.line_start ?? null,
        input.line_end ?? null,
        input.parent_symbol_id ?? null,
        input.indexing_run_id,
        created_at,
      );
    return {
      id,
      tenant_id: input.tenant_id,
      file_id: input.file_id,
      kind: input.kind,
      name: input.name,
      fqn: input.fqn ?? null,
      signature: input.signature ?? null,
      line_start: input.line_start ?? null,
      line_end: input.line_end ?? null,
      parent_symbol_id: input.parent_symbol_id ?? null,
      indexing_run_id: input.indexing_run_id,
      created_at,
      deleted_at: null,
    };
  }

  async listSymbolsByFile(tenant_id: string, file_id: string): Promise<SymbolRow[]> {
    return (await this.db
      .prepare(
        `SELECT * FROM ${SYMBOLS_TABLE} WHERE tenant_id = ${this.ph(1)} AND file_id = ${this.ph(2)} AND deleted_at IS NULL ORDER BY line_start ASC`,
      )
      .all(tenant_id, file_id)) as SymbolRow[];
  }

  async findSymbolByName(tenant_id: string, name: string, limit = 50): Promise<SymbolRow[]> {
    return (await this.db
      .prepare(
        `SELECT * FROM ${SYMBOLS_TABLE} WHERE tenant_id = ${this.ph(1)} AND name = ${this.ph(2)} AND deleted_at IS NULL LIMIT ${this.ph(3)}`,
      )
      .all(tenant_id, name, limit)) as SymbolRow[];
  }
}
