/**
 * Extractor -- streams rows into the unified code-intel store.
 *
 * The contract is deliberately minimal: an extractor declares the row kinds
 * it produces, decides whether a repo is indexable, and yields rows that the
 * pipeline persists tagged with the current indexing_run_id.
 *
 * Example:
 *   const filesExtractor: Extractor = {
 *     name: "files",
 *     produces: ["files"],
 *     supports: () => true,
 *     async *run(ctx) {
 *       for (const entry of walkFiles(ctx.repo.local_path!)) {
 *         yield { kind: "files", row: entry };
 *       }
 *     },
 *   };
 */

import type { CodeIntelStore } from "../store.js";
import type { IndexingRun, Repo, RowKind } from "./types.js";
import type { VendorResolver } from "./vendor.js";

/** A single row emitted by an extractor, tagged by kind. */
export interface ExtractorRow {
  kind: RowKind;
  row: Record<string, unknown>;
}

/** Context handed to an extractor for the lifetime of one run. */
export interface ExtractorContext {
  repo: Repo;
  run: IndexingRun;
  store: CodeIntelStore;
  vendor: VendorResolver;
  /** Optional signal for cancellation. */
  signal?: AbortSignal;
}

export interface Extractor {
  /** Stable identifier used by `ark code-intel extractors` + pipeline logs. */
  readonly name: string;
  /** Row kinds this extractor writes. Declared so the pipeline can plan I/O. */
  readonly produces: ReadonlyArray<RowKind>;
  /** Fast check: does this extractor apply to `repo`? (Wrong answer = skipped.) */
  supports(repo: Repo): boolean;
  /** Streaming row production. The pipeline persists each yielded row. */
  run(ctx: ExtractorContext): AsyncIterable<ExtractorRow>;
}
