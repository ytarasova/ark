/**
 * contributor-expertise-map -- mechanical (Wave 2c).
 *
 * Renders "who knows what" per repo in the workspace as a Markdown table.
 * Uses the `contributions` table (Wave 1) joined to `people` for names.
 *
 * Strategy:
 *   - Per repo, list the top-N contributors by commit count.
 *   - Resolve person_id -> {primary_email, name} via `listPeople`.
 *   - Include commit count, LOC added/removed, first + last commit.
 *
 * Graceful path: if a repo has no contributions rows yet, an explanatory
 * line is emitted instead of a table.
 */

import type {
  PlatformDocContext,
  PlatformDocExtractor,
  PlatformDocInput,
} from "../../interfaces/platform-doc-extractor.js";

const TOP_N_PER_REPO = 10;

function shortDate(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

export const contributorExpertiseMapExtractor: PlatformDocExtractor = {
  doc_type: "contributor_expertise_map",
  flavor: "mechanical",
  cadence: "on_reindex",
  async generate(ctx: PlatformDocContext, workspace_id: string): Promise<PlatformDocInput> {
    const repos = await ctx.store.listReposInWorkspace(ctx.tenant_id, workspace_id);
    if (repos.length === 0) {
      return {
        title: "Contributor Expertise Map",
        content_md:
          "# Contributor Expertise Map\n\n" +
          "_No repos are attached to this workspace yet._\n\n" +
          "Run `ark workspace add-repo <slug> <path>` to attach repos, then\n" +
          "`ark code-intel reindex` and `ark code-intel docs regenerate --doc contributor_expertise_map`.\n",
        source: { repo_count: 0, contribution_count: 0 },
      };
    }

    // Build a person_id -> display info map once per workspace.
    const people = await ctx.store.listPeople(ctx.tenant_id);
    const peopleById = new Map<string, { name: string; email: string }>();
    for (const p of people) {
      peopleById.set(p.id, { name: p.name ?? p.primary_email, email: p.primary_email });
    }

    let totalContribRows = 0;
    const sections: string[] = [];
    for (const repo of repos) {
      const contribs = await ctx.store.listContributionsForRepo(ctx.tenant_id, repo.id, TOP_N_PER_REPO);
      if (contribs.length === 0) {
        sections.push(`### ${repo.name}\n\n_No contributor data indexed yet._\n`);
        continue;
      }
      totalContribRows += contribs.length;
      const rows = contribs
        .map((c) => {
          const who = peopleById.get(c.person_id);
          const name = who?.name ?? "(unknown)";
          const email = who?.email ?? "";
          return `| ${name} | ${email} | ${c.commit_count} | +${c.loc_added}/-${c.loc_removed} | ${shortDate(c.first_commit)} | ${shortDate(c.last_commit)} |`;
        })
        .join("\n");
      sections.push(
        `### ${repo.name}\n\n` +
          `| contributor | email | commits | LOC | first | last |\n` +
          `|---|---|---:|---|---|---|\n` +
          `${rows}\n`,
      );
    }

    const header =
      `# Contributor Expertise Map\n\n` +
      `**${repos.length}** repo${repos.length === 1 ? "" : "s"} in this workspace -- top ` +
      `${TOP_N_PER_REPO} contributors per repo.\n\n` +
      (totalContribRows === 0
        ? `_No contribution data across any repo. Run \`ark code-intel reindex\` to run the git-contributors extractor._\n\n`
        : "") +
      `## Per-repo tables\n\n`;

    return {
      title: "Contributor Expertise Map",
      content_md: header + sections.join("\n"),
      source: {
        repo_count: repos.length,
        contribution_row_count: totalContribRows,
        people_total: people.length,
      },
    };
  },
};
