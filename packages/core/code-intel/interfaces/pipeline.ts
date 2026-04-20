/**
 * Pipeline -- orchestrates extractors against a repo, producing IndexingRuns.
 *
 * Three entry points:
 *   - runFullIndex: every extractor on every supported repo.
 *   - runIncremental: only changed files since a commit.
 *   - runSubset: named extractors (e.g. "files,dependencies").
 *
 * D8 (agent-as-extractor) and D11 (speculative pre-warm) both hook here.
 *
 * Example:
 *   const pipeline: Pipeline = {
 *     runFullIndex: (t, r) => pipelineRunFullIndex(deployment, t, r),
 *     runIncremental: (t, r, s) => pipelineRunIncremental(deployment, t, r, s),
 *     runSubset: (t, r, names) => pipelineRunSubset(deployment, t, r, names),
 *   };
 */

import type { IndexingRun } from "./types.js";

export interface Pipeline {
  runFullIndex(tenant_id: string, repo_id: string): Promise<IndexingRun>;
  runIncremental(tenant_id: string, repo_id: string, since_commit: string): Promise<IndexingRun>;
  runSubset(tenant_id: string, repo_id: string, extractor_names: ReadonlyArray<string>): Promise<IndexingRun>;
}
