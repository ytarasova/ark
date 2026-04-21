/**
 * `get_context` query method -- assembles a multi-table snapshot for one
 * subject (file path, file id, or symbol name).
 *
 * Returns:
 *   {
 *     file: FileRow | null,
 *     symbols_in_file: SymbolRow[],
 *     recent_commits: { author, count, last }[] (top 5 by recency),
 *     top_contributors: ContributionRow[],
 *     dependents_count: number,
 *   }
 */

import type { QueryContext, QueryMethod } from "../interfaces/query.js";
import type { ContributionRow, FileRow, SymbolRow } from "../store.js";

export interface GetContextArgs {
  /** A file path (relative to the repo root), a file id, or a symbol name. */
  subject: string;
  repo_id?: string;
}

export interface GetContextResult {
  file: FileRow | null;
  symbols_in_file: SymbolRow[];
  top_contributors: Array<
    Pick<ContributionRow, "person_id" | "commit_count" | "loc_added" | "loc_removed" | "last_commit">
  >;
  dependents_count: number;
}

export const getContextQuery: QueryMethod<GetContextArgs, GetContextResult> = {
  name: "get_context",
  scope: "read",
  cost: "moderate",
  async run(ctx: QueryContext, args: GetContextArgs): Promise<GetContextResult> {
    const empty: GetContextResult = {
      file: null,
      symbols_in_file: [],
      top_contributors: [],
      dependents_count: 0,
    };

    let file: FileRow | null = null;

    // Try as file id first.
    file = await ctx.store.getFile(ctx.tenant_id, args.subject);

    // If not a file id and we have a repo_id, try as a path.
    if (!file && args.repo_id) {
      file = await ctx.store.findFileByPath(ctx.tenant_id, args.repo_id, args.subject);
    }

    // If still no file, try resolving via symbol name -> first symbol's file.
    if (!file) {
      const symbols = await ctx.store.findSymbolByName(ctx.tenant_id, args.subject, 1);
      if (symbols.length > 0) {
        file = await ctx.store.getFile(ctx.tenant_id, symbols[0].file_id);
      }
    }

    if (!file) return empty;

    const symbols_in_file = await ctx.store.listSymbolsByFile(ctx.tenant_id, file.id);
    const contribs = await ctx.store.listContributionsForFile(ctx.tenant_id, file.id, 5);
    const top_contributors = contribs.map((c) => ({
      person_id: c.person_id,
      commit_count: c.commit_count,
      loc_added: c.loc_added,
      loc_removed: c.loc_removed,
      last_commit: c.last_commit,
    }));

    // Dependents = inbound edges to this file. Counts symbol-level edges into any of the file's symbols
    // plus direct file-level edges.
    let dependents_count = (await ctx.store.listEdgesTo(ctx.tenant_id, "file", file.id)).length;
    for (const s of symbols_in_file) {
      dependents_count += (await ctx.store.listEdgesTo(ctx.tenant_id, "symbol", s.id)).length;
    }

    return { file, symbols_in_file, top_contributors, dependents_count };
  },
};
