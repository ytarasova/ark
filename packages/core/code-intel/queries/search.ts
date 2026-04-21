/**
 * `search` query method -- FTS across chunks + files + symbols.
 *
 * Local (SQLite) uses the FTS5 virtual table `code_intel_chunks_fts`
 * populated on insert. Postgres uses the generated `fts_tsv` column.
 *
 * Returns candidates with a uniform shape regardless of dialect.
 */

import type { QueryMethod, QueryContext } from "../interfaces/query.js";

export interface SearchArgs {
  query: string;
  limit?: number;
}

export interface SearchHit {
  chunk_id: string;
  file_id: string;
  symbol_id: string | null;
  chunk_kind: string;
  content_preview: string;
  score: number;
}

export const searchQuery: QueryMethod<SearchArgs, SearchHit[]> = {
  name: "search",
  scope: "read",
  cost: "cheap",
  async run(ctx: QueryContext, args: SearchArgs): Promise<SearchHit[]> {
    const limit = Math.max(1, Math.min(args.limit ?? 25, 200));
    const rows = await ctx.store.searchChunks(ctx.tenant_id, args.query, limit);
    return rows.map((r) => ({
      chunk_id: r.id,
      file_id: r.file_id,
      symbol_id: r.symbol_id,
      chunk_kind: r.chunk_kind,
      content_preview: (r.content ?? "").slice(0, 240),
      score: r.match_score,
    }));
  },
};
