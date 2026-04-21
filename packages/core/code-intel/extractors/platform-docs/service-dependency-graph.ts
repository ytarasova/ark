/**
 * service-dependency-graph -- mechanical (Wave 2c).
 *
 * Renders a Mermaid flowchart showing the dependencies of each repo in the
 * workspace. Read directly from the `code_intel_dependencies` table (landed
 * in Wave 1 via the syft extractor).
 *
 * Output shape:
 *   - H1 title + summary line (N repos, M total dependencies).
 *   - One Mermaid `flowchart` block grouping repos -> top deps per repo
 *     (capped so the graph stays legible on large workspaces).
 *   - A per-repo Markdown table as a fallback / text-searchable companion.
 *
 * Graceful path: if the workspace has zero repos or zero dependencies, the
 * extractor emits an explanatory stub that tells the caller what to run
 * next, rather than throwing.
 */

import type {
  PlatformDocContext,
  PlatformDocExtractor,
  PlatformDocInput,
} from "../../interfaces/platform-doc-extractor.js";

const MAX_DEPS_PER_REPO_IN_GRAPH = 8;
const MAX_REPOS_IN_GRAPH = 40;

/** Mermaid node ids must be identifier-safe. Strip everything else. */
function mermaidId(prefix: string, value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return `${prefix}_${safe || "x"}`;
}

export const serviceDependencyGraphExtractor: PlatformDocExtractor = {
  doc_type: "service_dependency_graph",
  flavor: "mechanical",
  cadence: "on_reindex",
  async generate(ctx: PlatformDocContext, workspace_id: string): Promise<PlatformDocInput> {
    const repos = await ctx.store.listReposInWorkspace(ctx.tenant_id, workspace_id);
    if (repos.length === 0) {
      return {
        title: "Service Dependency Graph",
        content_md:
          "# Service Dependency Graph\n\n" +
          "_No repos are attached to this workspace yet._\n\n" +
          "Run `ark workspace add-repo <slug> <path>` to attach repos, then\n" +
          "`ark code-intel reindex` and `ark code-intel docs regenerate --doc service_dependency_graph`.\n",
        source: { repo_count: 0, dependency_count: 0 },
      };
    }

    // Pull dependencies per repo; tally totals as we go.
    const perRepo = await Promise.all(
      repos.map(async (r) => {
        const deps = await ctx.store.listDependencies(ctx.tenant_id, r.id);
        return { repo: r, deps };
      }),
    );
    const totalDeps = perRepo.reduce((acc, r) => acc + r.deps.length, 0);

    if (totalDeps === 0) {
      return {
        title: "Service Dependency Graph",
        content_md:
          `# Service Dependency Graph\n\n` +
          `**${repos.length}** repo${repos.length === 1 ? "" : "s"} in this workspace, ` +
          `but **no dependency data has been indexed yet**.\n\n` +
          `Run \`ark code-intel reindex\` (with syft installed) to populate the\n` +
          `\`dependencies\` table, then regenerate this doc.\n\n` +
          `Repos:\n` +
          repos.map((r) => `  - ${r.name} (${r.id.slice(0, 8)})`).join("\n") +
          "\n",
        source: { repo_count: repos.length, dependency_count: 0 },
      };
    }

    // Build Mermaid flowchart lines. Cap the rendered graph so we don't
    // ship 10k-node blobs; the full table below lists everything.
    const lines: string[] = ["```mermaid", "flowchart LR"];
    const reposInGraph = perRepo.slice(0, MAX_REPOS_IN_GRAPH);
    for (const { repo, deps } of reposInGraph) {
      const repoNode = mermaidId("repo", repo.name);
      lines.push(`  ${repoNode}["${repo.name}"]`);
      const topDeps = deps.slice(0, MAX_DEPS_PER_REPO_IN_GRAPH);
      for (const d of topDeps) {
        const depNode = mermaidId("dep", `${d.manifest_kind}_${d.name}`);
        const label = d.resolved_version ?? d.version_constraint ?? "";
        lines.push(`  ${depNode}(["${d.name}${label ? ` ${label}` : ""}"])`);
        lines.push(`  ${repoNode} --> ${depNode}`);
      }
    }
    lines.push("```");

    // Per-repo Markdown tables.
    const sections: string[] = [];
    for (const { repo, deps } of perRepo) {
      if (deps.length === 0) {
        sections.push(`### ${repo.name}\n\n_No dependencies indexed._\n`);
        continue;
      }
      const rows = deps
        .map(
          (d) =>
            `| ${d.manifest_kind} | ${d.name} | ${d.resolved_version ?? ""} | ${d.version_constraint ?? ""} | ${d.dep_type} |`,
        )
        .join("\n");
      sections.push(
        `### ${repo.name}\n\n` +
          `| manifest | name | resolved | constraint | type |\n` +
          `|---|---|---|---|---|\n` +
          `${rows}\n`,
      );
    }

    const header =
      `# Service Dependency Graph\n\n` +
      `**${repos.length}** repo${repos.length === 1 ? "" : "s"} -- **${totalDeps}** ` +
      `total dependency row${totalDeps === 1 ? "" : "s"} indexed.\n\n` +
      `## Graph\n\n` +
      lines.join("\n") +
      "\n\n" +
      (reposInGraph.length < repos.length
        ? `_Graph capped at ${MAX_REPOS_IN_GRAPH} repos; see per-repo tables for the full picture._\n\n`
        : "") +
      `## Per-repo dependency tables\n\n`;

    return {
      title: "Service Dependency Graph",
      content_md: header + sections.join("\n"),
      source: {
        repo_count: repos.length,
        dependency_count: totalDeps,
        repos_in_graph: reposInGraph.length,
      },
    };
  },
};
