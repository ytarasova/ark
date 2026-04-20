/**
 * Pipeline runner -- drives extractors against a repo + persists rows.
 *
 * Wave 1 implements `runFullIndex` and `runSubset`. Incremental indexing
 * (commit-diff scope) lands in Wave 2 alongside the file-sha diff helper.
 *
 * Persistence quirks worth noting:
 *  - The `git-contributors` extractor emits `people` first, then
 *    `contributions` rows tagged with `person_email`. We resolve the email
 *    to a `person_id` here so the extractor can stay declarative.
 *  - Every extractor yields rows tagged with the active run; we just
 *    forward them to the matching `store.insert*` method.
 */

import type { CodeIntelStore } from "./store.js";
import type { Extractor, ExtractorContext, ExtractorRow } from "./interfaces/extractor.js";
import type { Pipeline } from "./interfaces/pipeline.js";
import type { IndexingRun, Repo } from "./interfaces/types.js";
import type { VendorResolver } from "./interfaces/vendor.js";

export interface PipelineOptions {
  store: CodeIntelStore;
  vendor: VendorResolver;
  extractors: ReadonlyArray<Extractor>;
}

export class CodeIntelPipeline implements Pipeline {
  constructor(private readonly opts: PipelineOptions) {}

  async runFullIndex(tenant_id: string, repo_id: string): Promise<IndexingRun> {
    return this.runImpl(tenant_id, repo_id, this.opts.extractors);
  }

  async runIncremental(tenant_id: string, repo_id: string, _since_commit: string): Promise<IndexingRun> {
    // Wave 2 will diff (file_id, sha) against the prior active run and only
    // re-extract for changed files. Wave 1 falls back to a full index so the
    // pipeline returns a valid run.
    return this.runFullIndex(tenant_id, repo_id);
  }

  async runSubset(tenant_id: string, repo_id: string, extractor_names: ReadonlyArray<string>): Promise<IndexingRun> {
    const named = new Set(extractor_names);
    const subset = this.opts.extractors.filter((e) => named.has(e.name));
    return this.runImpl(tenant_id, repo_id, subset);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async runImpl(
    tenant_id: string,
    repo_id: string,
    extractors: ReadonlyArray<Extractor>,
  ): Promise<IndexingRun> {
    const repo = this.requireRepo(tenant_id, repo_id);
    const runDb = this.opts.store.beginIndexingRun({
      tenant_id,
      repo_id,
      branch: repo.default_branch,
    });
    const run: IndexingRun = {
      id: runDb.id,
      tenant_id: runDb.tenant_id,
      repo_id: runDb.repo_id,
      branch: runDb.branch,
      commit: runDb.commit_sha ?? null,
      status: runDb.status,
      started_at: runDb.started_at,
    };
    const counts: Record<string, number> = {};
    let errorMsg: string | null = null;

    try {
      for (const extractor of extractors) {
        if (!extractor.supports(repo)) {
          counts[`${extractor.name}.skipped`] = 1;
          continue;
        }
        const ctx: ExtractorContext = {
          repo,
          run,
          store: this.opts.store,
          vendor: this.opts.vendor,
        };
        let rowCount = 0;
        for await (const row of extractor.run(ctx)) {
          this.persist(row);
          rowCount += 1;
        }
        counts[extractor.name] = rowCount;
      }
      this.opts.store.finalizeIndexingRun({
        run_id: run.id,
        status: "ok",
        extractor_counts: counts,
      });
      return { ...run, status: "ok", extractor_counts: counts };
    } catch (err: any) {
      errorMsg = err?.message ?? String(err);
      this.opts.store.finalizeIndexingRun({
        run_id: run.id,
        status: "error",
        extractor_counts: counts,
        error_msg: errorMsg,
      });
      return { ...run, status: "error", extractor_counts: counts, error_msg: errorMsg };
    }
  }

  private requireRepo(tenant_id: string, repo_id: string): Repo {
    const r = this.opts.store.getRepo(tenant_id, repo_id);
    if (!r) throw new Error(`pipeline: repo ${repo_id} not found for tenant ${tenant_id}`);
    return {
      id: r.id,
      tenant_id: r.tenant_id,
      repo_url: r.repo_url,
      name: r.name,
      default_branch: r.default_branch,
      primary_language: r.primary_language,
      local_path: r.local_path,
    };
  }

  private persist(row: ExtractorRow): void {
    const r = row.row;
    switch (row.kind) {
      case "files":
        this.opts.store.insertFile(r as any);
        return;
      case "symbols":
        this.opts.store.insertSymbol(r as any);
        return;
      case "chunks":
        this.opts.store.insertChunk(r as any);
        return;
      case "edges":
        this.opts.store.insertEdge(r as any);
        return;
      case "external_refs":
        this.opts.store.insertExternalRef(r as any);
        return;
      case "embeddings":
        this.opts.store.insertEmbedding(r as any);
        return;
      case "dependencies":
        this.opts.store.insertDependency(r as any);
        return;
      case "people":
        this.opts.store.upsertPerson(r as any);
        return;
      case "contributions": {
        // git-contributors yields person_email; resolve to person_id here.
        const emailField = (r as any).person_email;
        if (emailField && !(r as any).person_id) {
          const tenant_id = String((r as any).tenant_id);
          const person = this.opts.store.upsertPerson({
            tenant_id,
            primary_email: String(emailField),
            name: null,
          });
          (r as any).person_id = person.id;
        }
        delete (r as any).person_email;
        this.opts.store.insertContribution(r as any);
        return;
      }
      case "file_hotspots":
        this.opts.store.insertHotspot(r as any);
        return;
      // Wave 2 row kinds: store hooks ship in Wave 2; ignore for now.
      case "endpoints":
      case "configs":
      case "infra_resources":
      case "test_mappings":
      case "semantic_annotations":
      case "contracts":
      case "test_assertions":
        return;
      default:
        return;
    }
  }
}
