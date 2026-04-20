/**
 * `ark workspace` -- Wave 2a CLI surface for the new workspace layer.
 *
 * A workspace groups N repos for cross-repo queries, platform docs, and
 * (Wave 2b) multi-repo session dispatch. Wave 2a ships CRUD + repo
 * attachment only. YAML is the only authored output format; there is no
 * `--json` flag (use `--format yaml` explicitly, or stick with text).
 *
 *   ark workspace create <slug> [--tenant <t>] [--name <n>] [--description <d>]
 *   ark workspace list [--tenant <t>] [--format yaml|text]
 *   ark workspace show <slug> [--format yaml|text]
 *   ark workspace use <slug>
 *   ark workspace add-repo <workspace-slug> <repo-path-or-url>
 *   ark workspace remove-repo <workspace-slug> <repo>
 */

import type { Command } from "commander";
import chalk from "chalk";
import YAML from "yaml";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import type { AppContext } from "../../core/app.js";
import { DEFAULT_TENANT_ID } from "../../core/code-intel/constants.js";

function resolveTenantId(app: AppContext, explicitSlug?: string | null): string {
  if (explicitSlug) {
    const t = app.codeIntel.getTenantBySlug(explicitSlug);
    if (!t) throw new Error(`tenant "${explicitSlug}" not found -- run \`ark tenant create\` first`);
    return t.id;
  }
  const fallbackSlug = app.config.authSection.defaultTenant;
  if (fallbackSlug) {
    const t = app.codeIntel.getTenantBySlug(fallbackSlug);
    if (t) return t.id;
  }
  return DEFAULT_TENANT_ID;
}

function findRepoForWorkspace(
  app: AppContext,
  tenant_id: string,
  query: string,
): { id: string; name: string; repo_url: string } | null {
  const repos = app.codeIntel.listRepos(tenant_id);
  // Match: repo id (full or prefix), name, or URL.
  return (
    repos.find((r) => r.id === query || r.id.startsWith(query) || r.name === query || r.repo_url === query) ?? null
  );
}

/**
 * Persist `active_workspace: <slug>` to `{arkDir}/config.yaml`, preserving
 * every other key. Creates the file + dirs if they don't exist.
 */
function setActiveWorkspaceInConfig(arkDir: string, slug: string): string {
  const path = join(arkDir, "config.yaml");
  let doc: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = YAML.parse(readFileSync(path, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error(`Cannot parse existing config at ${path}; fix it manually before running \`workspace use\`.`);
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  doc.active_workspace = slug;
  writeFileSync(path, YAML.stringify(doc), "utf-8");
  return path;
}

export function registerWorkspaceCommands(program: Command, app: AppContext) {
  const cmd = program.command("workspace").description("Manage workspaces (tenant -> workspace -> repo)");

  // ── create ──────────────────────────────────────────────────────────────
  cmd
    .command("create")
    .description("Create a new workspace")
    .argument("<slug>", "Workspace slug (unique per tenant)")
    .option("--tenant <slug>", "Tenant slug (default: local default)")
    .option("--name <name>", "Display name (default: derived from slug)")
    .option("--description <text>", "Free-form description")
    .action((slug: string, opts) => {
      try {
        const tenant_id = resolveTenantId(app, opts.tenant);
        const existing = app.codeIntel.getWorkspaceBySlug(tenant_id, slug);
        if (existing) {
          console.log(chalk.yellow(`Workspace '${slug}' already exists (${existing.id.slice(0, 8)})`));
          return;
        }
        const name = opts.name ?? slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
        const created = app.codeIntel.createWorkspace({
          tenant_id,
          slug,
          name,
          description: opts.description ?? null,
        });
        console.log(chalk.green(`Created workspace '${created.slug}' (${created.id.slice(0, 8)})`));
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exitCode = 1;
      }
    });

  // ── list ────────────────────────────────────────────────────────────────
  cmd
    .command("list")
    .description("List workspaces for a tenant")
    .option("--tenant <slug>", "Tenant slug (default: local default)")
    .option("--format <fmt>", "Output format: yaml | text", "text")
    .action((opts) => {
      try {
        const tenant_id = resolveTenantId(app, opts.tenant);
        const workspaces = app.codeIntel.listWorkspaces(tenant_id);
        if (opts.format === "yaml") {
          console.log(
            YAML.stringify(
              workspaces.map((w) => ({
                slug: w.slug,
                id: w.id,
                name: w.name,
                description: w.description,
                repo_count: app.codeIntel.listReposInWorkspace(tenant_id, w.id).length,
                created_at: w.created_at,
              })),
            ),
          );
          return;
        }
        if (workspaces.length === 0) {
          console.log(chalk.dim("No workspaces. Create one with `ark workspace create <slug>`."));
          return;
        }
        for (const w of workspaces) {
          const repos = app.codeIntel.listReposInWorkspace(tenant_id, w.id);
          console.log(
            `  ${chalk.cyan(w.slug.padEnd(20))} ${chalk.bold(w.name.padEnd(24))} ${chalk.dim(`${repos.length} repo${repos.length === 1 ? "" : "s"}`)}`,
          );
        }
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exitCode = 1;
      }
    });

  // ── show ────────────────────────────────────────────────────────────────
  cmd
    .command("show")
    .description("Show a workspace + attached repos")
    .argument("<slug>", "Workspace slug")
    .option("--tenant <slug>", "Tenant slug (default: local default)")
    .option("--format <fmt>", "Output format: yaml | text", "text")
    .action((slug: string, opts) => {
      try {
        const tenant_id = resolveTenantId(app, opts.tenant);
        const ws = app.codeIntel.getWorkspaceBySlug(tenant_id, slug);
        if (!ws) {
          console.error(chalk.red(`Workspace '${slug}' not found`));
          process.exitCode = 1;
          return;
        }
        const repos = app.codeIntel.listReposInWorkspace(tenant_id, ws.id);
        if (opts.format === "yaml") {
          console.log(
            YAML.stringify({
              slug: ws.slug,
              id: ws.id,
              name: ws.name,
              description: ws.description,
              tenant_id: ws.tenant_id,
              created_at: ws.created_at,
              repos: repos.map((r) => ({
                id: r.id,
                name: r.name,
                repo_url: r.repo_url,
                default_branch: r.default_branch,
              })),
            }),
          );
          return;
        }
        console.log(chalk.bold(ws.name));
        console.log(`  ${chalk.dim("slug")}        ${ws.slug}`);
        console.log(`  ${chalk.dim("id")}          ${ws.id}`);
        if (ws.description) console.log(`  ${chalk.dim("description")} ${ws.description}`);
        console.log(`  ${chalk.dim("created")}     ${ws.created_at}`);
        console.log(`  ${chalk.dim("repos")}       ${repos.length}`);
        for (const r of repos) {
          console.log(`    ${chalk.cyan(r.id.slice(0, 8))} ${chalk.bold(r.name)} ${chalk.dim(r.repo_url)}`);
        }
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exitCode = 1;
      }
    });

  // ── use ─────────────────────────────────────────────────────────────────
  cmd
    .command("use")
    .description("Set the active workspace (persisted to ~/.ark/config.yaml)")
    .argument("<slug>", "Workspace slug")
    .option("--tenant <slug>", "Tenant slug (default: local default)")
    .action((slug: string, opts) => {
      try {
        const tenant_id = resolveTenantId(app, opts.tenant);
        const ws = app.codeIntel.getWorkspaceBySlug(tenant_id, slug);
        if (!ws) {
          console.error(chalk.red(`Workspace '${slug}' not found`));
          process.exitCode = 1;
          return;
        }
        const written = setActiveWorkspaceInConfig(app.config.arkDir, ws.slug);
        console.log(chalk.green(`Active workspace set to '${ws.slug}' (${written})`));
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exitCode = 1;
      }
    });

  // ── add-repo ────────────────────────────────────────────────────────────
  cmd
    .command("add-repo")
    .description("Attach a repo to a workspace (creates the repo if it's a new path/URL)")
    .argument("<workspace-slug>", "Workspace slug")
    .argument("<repo-path-or-url>", "Repo path, URL, or existing repo id / name")
    .option("--tenant <slug>", "Tenant slug (default: local default)")
    .action((workspaceSlug: string, repoArg: string, opts) => {
      try {
        const tenant_id = resolveTenantId(app, opts.tenant);
        const ws = app.codeIntel.getWorkspaceBySlug(tenant_id, workspaceSlug);
        if (!ws) {
          console.error(chalk.red(`Workspace '${workspaceSlug}' not found`));
          process.exitCode = 1;
          return;
        }

        // Resolve to an existing repo first, then fall back to auto-registering
        // a new one (mirrors `ark code-intel repo add` behavior).
        let repoId: string;
        let repoName: string;
        const existingByIdOrName = findRepoForWorkspace(app, tenant_id, repoArg);
        if (existingByIdOrName) {
          repoId = existingByIdOrName.id;
          repoName = existingByIdOrName.name;
        } else {
          const isLocal = existsSync(repoArg);
          const repo_url = isLocal ? `file://${resolve(repoArg)}` : repoArg;
          const existingByUrl = app.codeIntel.findRepoByUrl(tenant_id, repo_url);
          if (existingByUrl) {
            repoId = existingByUrl.id;
            repoName = existingByUrl.name;
          } else {
            const derivedName = (isLocal ? resolve(repoArg).split("/").pop() : repoArg.split("/").pop()) ?? "repo";
            const created = app.codeIntel.createRepo({
              tenant_id,
              repo_url,
              name: derivedName,
              local_path: isLocal ? resolve(repoArg) : null,
            });
            repoId = created.id;
            repoName = created.name;
          }
        }

        app.codeIntel.addRepoToWorkspace(repoId, ws.id);
        console.log(chalk.green(`Attached '${repoName}' (${repoId.slice(0, 8)}) to workspace '${ws.slug}'`));
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exitCode = 1;
      }
    });

  // ── remove-repo ─────────────────────────────────────────────────────────
  cmd
    .command("remove-repo")
    .description("Detach a repo from a workspace (repo itself is not deleted)")
    .argument("<workspace-slug>", "Workspace slug")
    .argument("<repo>", "Repo id, name, or URL")
    .option("--tenant <slug>", "Tenant slug (default: local default)")
    .action((workspaceSlug: string, repoArg: string, opts) => {
      try {
        const tenant_id = resolveTenantId(app, opts.tenant);
        const ws = app.codeIntel.getWorkspaceBySlug(tenant_id, workspaceSlug);
        if (!ws) {
          console.error(chalk.red(`Workspace '${workspaceSlug}' not found`));
          process.exitCode = 1;
          return;
        }
        const repo = findRepoForWorkspace(app, tenant_id, repoArg);
        if (!repo) {
          console.error(chalk.red(`Repo '${repoArg}' not found in tenant`));
          process.exitCode = 1;
          return;
        }
        const current = app.codeIntel.getRepoWorkspaceId(repo.id);
        if (current !== ws.id) {
          console.log(chalk.yellow(`Repo '${repo.name}' is not attached to workspace '${ws.slug}'; nothing to do.`));
          return;
        }
        app.codeIntel.removeRepoFromWorkspace(repo.id);
        console.log(chalk.green(`Detached '${repo.name}' from workspace '${ws.slug}'`));
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exitCode = 1;
      }
    });
}
