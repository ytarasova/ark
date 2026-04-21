/**
 * KnowledgeClient -- memory + knowledge-graph RPCs.
 *
 * Carries the memory/knowledge half of the agent-D block (remember +
 * recall) -- see marker below. The code-intel v2 surface and the
 * workspace CRUD pieces live in `./code-intel.ts` and `./workspace.ts`.
 */

import type {
  MemoryEntry,
  MemoryListResult,
  MemoryRecallResult,
  MemoryForgetResult,
  MemoryAddResult,
  MemoryClearResult,
} from "../../types/index.js";
import type { RpcFn } from "./rpc.js";

export class KnowledgeClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  // ── Memory ─────────────────────────────────────────────────────────────────

  async memoryList(scope?: string): Promise<MemoryEntry[]> {
    const { memories } = await this.rpc<MemoryListResult>("memory/list", { scope });
    return memories;
  }

  async memoryRecall(query: string, opts?: { scope?: string; limit?: number }): Promise<MemoryEntry[]> {
    const { results } = await this.rpc<MemoryRecallResult>("memory/recall", { query, ...opts });
    return results;
  }

  async memoryForget(id: string): Promise<boolean> {
    const { ok } = await this.rpc<MemoryForgetResult>("memory/forget", { id });
    return ok;
  }

  async memoryAdd(
    content: string,
    opts?: { tags?: string[]; scope?: string; importance?: number },
  ): Promise<MemoryEntry> {
    const { memory } = await this.rpc<MemoryAddResult>("memory/add", { content, ...opts });
    return memory;
  }

  async memoryClear(scope?: string): Promise<number> {
    const { count } = await this.rpc<MemoryClearResult>("memory/clear", { scope });
    return count;
  }

  // ── Knowledge graph ────────────────────────────────────────────────────────

  async knowledgeSearch(
    query: string,
    opts?: { types?: string[]; limit?: number },
  ): Promise<
    Array<{
      id: string;
      type: string;
      label: string;
      content: string | null;
      score: number;
      metadata: Record<string, unknown>;
    }>
  > {
    const { results } = await this.rpc<{ results: any[] }>("knowledge/search", { query, ...opts });
    return results;
  }

  async knowledgeStats(): Promise<{
    nodes: number;
    edges: number;
    by_node_type: Record<string, number>;
    by_edge_type: Record<string, number>;
  }> {
    return this.rpc("knowledge/stats");
  }

  async knowledgeIndex(
    repo?: string,
  ): Promise<{ ok: boolean; files?: number; symbols?: number; edges?: number; duration_ms?: number; error?: string }> {
    return this.rpc("knowledge/index", { repo });
  }

  async knowledgeExport(dir?: string): Promise<{ ok: boolean; exported?: number }> {
    return this.rpc("knowledge/export", { dir });
  }

  async knowledgeImport(dir?: string): Promise<{ ok: boolean; imported?: number }> {
    return this.rpc("knowledge/import", { dir });
  }

  // --- BEGIN agent-D: knowledge memory operations (code-intel + workspace halves live in sibling files) ---

  /** Store a new memory node in the knowledge graph. Tenant-scoped. */
  async knowledgeRemember(opts: {
    content: string;
    tags?: string[];
    importance?: number;
    scope?: string;
  }): Promise<{ ok: boolean; id: string }> {
    return this.rpc("knowledge/remember", opts as Record<string, unknown>);
  }

  /** Search memory + learning nodes. Tenant-scoped. */
  async knowledgeRecall(
    query: string,
    opts?: { limit?: number },
  ): Promise<{
    results: Array<{
      id: string;
      type: string;
      label: string;
      content: string | null;
      score: number;
      metadata: Record<string, unknown>;
    }>;
  }> {
    return this.rpc("knowledge/recall", { query, ...(opts ?? {}) });
  }

  // --- END agent-D (this file) ---
}
