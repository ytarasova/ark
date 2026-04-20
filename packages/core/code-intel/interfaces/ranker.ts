/**
 * Ranker -- re-orders a candidate list with a score + provenance.
 *
 * Queries return candidates; rankers blend signals (FTS score, semantic
 * score, recency, session success, contributor expertise) and produce a
 * final ordering plus a breakdown that the UI / CLI can surface.
 *
 * Example:
 *   const blended: Ranker = {
 *     name: "blended-v1",
 *     async rank(ctx, candidates) {
 *       return candidates.map((c) => ({ ...c, rank_score: c.base_score }));
 *     },
 *   };
 */

import type { QueryContext } from "./query.js";

export interface Candidate {
  /** Stable id of the underlying row (usually a chunk / symbol / file UUID). */
  id: string;
  /** Base score from the QueryMethod (e.g. FTS score, cosine similarity). */
  base_score: number;
  /** Row payload the UI wants to render. */
  payload: Record<string, unknown>;
}

export interface Ranked extends Candidate {
  rank_score: number;
  /** Optional: weighted signals that produced rank_score. D9 feeds UI tooltips. */
  breakdown?: Record<string, number>;
}

export interface Ranker {
  readonly name: string;
  rank(ctx: QueryContext, candidates: Candidate[]): Promise<Ranked[]>;
}
