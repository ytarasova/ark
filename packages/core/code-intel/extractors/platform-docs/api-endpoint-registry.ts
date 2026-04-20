/**
 * api-endpoint-registry -- mechanical (Wave 2c, stub).
 *
 * The full version of this doc reads from the Wave 2 `endpoints` table
 * (Spring / Express / FastAPI / etc. routes extracted via per-framework
 * tree-sitter queries). That table doesn't ship until later in Wave 2;
 * this extractor is shape-correct today and degrades gracefully with a
 * "run the endpoints extractor first" stub.
 *
 * Once the endpoints table lands, swap the stub body for a proper query +
 * table render. Consumers keep the same `doc_type`.
 */

import type {
  PlatformDocContext,
  PlatformDocExtractor,
  PlatformDocInput,
} from "../../interfaces/platform-doc-extractor.js";

export const apiEndpointRegistryExtractor: PlatformDocExtractor = {
  doc_type: "api_endpoint_registry",
  flavor: "mechanical",
  cadence: "on_reindex",
  async generate(ctx: PlatformDocContext, workspace_id: string): Promise<PlatformDocInput> {
    const repos = ctx.store.listReposInWorkspace(ctx.tenant_id, workspace_id);
    const repoCount = repos.length;
    const body =
      repoCount === 0
        ? `_No repos are attached to this workspace yet._\n\n` +
          `Attach repos with \`ark workspace add-repo <slug> <path>\`, reindex,\n` +
          `and then regenerate this doc once the Wave 2 endpoints extractor ships.\n`
        : `Scanned **${repoCount}** repo${repoCount === 1 ? "" : "s"}; no endpoint data\n` +
          `has been indexed yet.\n\n` +
          `The per-framework endpoints extractor (Spring, Express, FastAPI, etc.)\n` +
          `lands later in Wave 2. Once it runs, this doc will enumerate every HTTP\n` +
          `route discovered across the workspace.\n\n` +
          `Workspace repos:\n\n` +
          repos.map((r) => `- ${r.name} (${r.repo_url})`).join("\n") +
          "\n";
    return {
      title: "API Endpoint Registry",
      content_md: `# API Endpoint Registry\n\n${body}`,
      source: { repo_count: repoCount, endpoint_count: 0, stub: true },
    };
  },
};
