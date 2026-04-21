/**
 * database-schema-map -- mechanical (Wave 2c, structure-proof).
 *
 * The long-term version of this doc needs structural extractors (DDL
 * parsing, migration parsing, FK graph) that don't land until Wave 3. Wave
 * 2c ships a mechanical *placeholder-with-teeth*: it walks the files table
 * and enumerates every file that *looks like* database schema or migration
 * material, so the doc is useful today without pretending to have parsed
 * anything.
 *
 * Heuristic matchers (by path + filename):
 *   - `**` / migrations/  (flyway, liquibase, alembic, typeorm, etc.)
 *   - `**` / schema*.sql / *.ddl / *.sql files
 *   - Prisma `schema.prisma`, Ecto `*.exs` under `migrations/`
 *   - `db/schema.rb` (rails)
 *
 * Heuristic only -- never claims to describe columns. When Wave 3 ships
 * structural extractors, this extractor evolves in place to emit tables +
 * FKs instead of file listings; consumers stay on the same doc_type.
 */

import type {
  PlatformDocContext,
  PlatformDocExtractor,
  PlatformDocInput,
} from "../../interfaces/platform-doc-extractor.js";

const MIGRATION_DIRS = /(^|\/)(migrations?|db\/migrate)(\/|$)/i;
const SCHEMA_FILE = /(^|\/)(schema|structure)(\.|_).*\.(sql|rb|prisma|exs|ts|py)$/i;
const SQL_FILE = /\.(sql|ddl)$/i;
const PRISMA_FILE = /schema\.prisma$/i;

interface Hit {
  repo: string;
  path: string;
  kind: "migration" | "schema" | "sql" | "prisma";
}

function classify(path: string): Hit["kind"] | null {
  if (PRISMA_FILE.test(path)) return "prisma";
  if (MIGRATION_DIRS.test(path)) return "migration";
  if (SCHEMA_FILE.test(path)) return "schema";
  if (SQL_FILE.test(path)) return "sql";
  return null;
}

export const databaseSchemaMapExtractor: PlatformDocExtractor = {
  doc_type: "database_schema_map",
  flavor: "mechanical",
  cadence: "on_reindex",
  async generate(ctx: PlatformDocContext, workspace_id: string): Promise<PlatformDocInput> {
    const repos = await ctx.store.listReposInWorkspace(ctx.tenant_id, workspace_id);
    if (repos.length === 0) {
      return {
        title: "Database Schema Map",
        content_md:
          "# Database Schema Map\n\n" +
          "_No repos are attached to this workspace yet._\n\n" +
          "This mechanical Wave 2c extractor walks indexed files for ddl/migration\n" +
          "signatures. Structural column-level schema parsing is a Wave 3 deliverable.\n",
        source: { repo_count: 0, hit_count: 0 },
      };
    }

    const hits: Hit[] = [];
    for (const repo of repos) {
      // listFiles is capped at 1000 by default; 5000 is a cheap bump for
      // mechanical scans that care about path hits, not content.
      const files = await ctx.store.listFiles(ctx.tenant_id, repo.id, 5000);
      for (const f of files) {
        const kind = classify(f.path);
        if (kind) hits.push({ repo: repo.name, path: f.path, kind });
      }
    }

    if (hits.length === 0) {
      return {
        title: "Database Schema Map",
        content_md:
          `# Database Schema Map\n\n` +
          `Scanned **${repos.length}** repo${repos.length === 1 ? "" : "s"}; no DDL/migration\n` +
          `files detected by the Wave 2c path heuristics (\`migrations/\`, \`*.sql\`,\n` +
          `\`schema.prisma\`, etc.).\n\n` +
          `If this workspace does use a relational database, the files may live under\n` +
          `names this heuristic doesn't catch. Full structural parsing lands in Wave 3.\n`,
        source: { repo_count: repos.length, hit_count: 0 },
      };
    }

    // Group by repo -> kind.
    const byRepo = new Map<string, Map<Hit["kind"], string[]>>();
    for (const h of hits) {
      const perKind = byRepo.get(h.repo) ?? new Map();
      const list = perKind.get(h.kind) ?? [];
      list.push(h.path);
      perKind.set(h.kind, list);
      byRepo.set(h.repo, perKind);
    }

    const sections: string[] = [];
    for (const [repoName, perKind] of byRepo) {
      sections.push(`### ${repoName}\n`);
      for (const kind of ["prisma", "schema", "migration", "sql"] as const) {
        const paths = perKind.get(kind);
        if (!paths || paths.length === 0) continue;
        sections.push(`**${kind}** (${paths.length})`);
        sections.push("");
        for (const p of paths.slice(0, 40)) sections.push(`- ${p}`);
        if (paths.length > 40) sections.push(`- _...and ${paths.length - 40} more_`);
        sections.push("");
      }
    }

    const header =
      `# Database Schema Map\n\n` +
      `**${hits.length}** DDL/migration file${hits.length === 1 ? "" : "s"} detected ` +
      `across **${byRepo.size}** repo${byRepo.size === 1 ? "" : "s"}.\n\n` +
      `> Wave 2c is a path-heuristic scan. Table + column parsing and the FK\n` +
      `> graph land in Wave 3 (structural extractors). This doc's shape stays\n` +
      `> stable across that upgrade -- consumers keep the same doc_type.\n\n` +
      `## Files by repo\n\n`;

    return {
      title: "Database Schema Map",
      content_md: header + sections.join("\n"),
      source: {
        repo_count: repos.length,
        hit_count: hits.length,
        repos_with_hits: byRepo.size,
      },
    };
  },
};
