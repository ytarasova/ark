/**
 * HistoryService — wraps search and indexing operations.
 *
 * Kept minimal: delegates to the existing search module functions.
 * Full transcript indexing integration will be added in a later pass.
 */

import type { IDatabase } from "../database/index.js";

export interface HistorySearchResult {
  sessionId: string;
  source: string;
  match: string;
  timestamp?: string;
}

/** Raw row shape from sessions table for history search queries. */
interface HistoryRow {
  id: string;
  ticket: string | null;
  summary: string | null;
  repo: string | null;
  created_at: string;
}

export class HistoryService {
  constructor(private db: IDatabase) {}

  /**
   * Search sessions by metadata (ticket, summary, repo, id).
   * Uses simple LIKE queries against the sessions table.
   */
  search(query: string, opts?: { limit?: number }): HistorySearchResult[] {
    const limit = opts?.limit ?? 50;
    const pattern = `%${query}%`;
    const results: HistorySearchResult[] = [];

    const rows = this.db
      .prepare(
        `
      SELECT id, ticket, summary, repo, created_at FROM sessions
      WHERE (summary LIKE ? COLLATE NOCASE
         OR ticket LIKE ? COLLATE NOCASE
         OR repo LIKE ? COLLATE NOCASE
         OR id LIKE ? COLLATE NOCASE)
        AND status != 'deleting'
      ORDER BY created_at DESC LIMIT ?
    `,
      )
      .all(pattern, pattern, pattern, pattern, limit) as HistoryRow[];

    for (const row of rows) {
      results.push({
        sessionId: row.id,
        source: "metadata",
        match: row.summary ?? row.ticket ?? row.repo ?? "",
        timestamp: row.created_at,
      });
    }

    return results;
  }
}
