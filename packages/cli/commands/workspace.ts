/**
 * `ark workspace` -- thin CLI wrapper over the workspace/* RPCs.
 *
 * RPC methods (see packages/server/handlers/workspace.ts):
 *   workspace/list
 *   workspace/get
 *   workspace/create
 *   workspace/delete
 *   workspace/status
 *   workspace/add-repo
 *   workspace/remove-repo
 *
 * Local-by-nature punts (documented):
 *
 *   `ark workspace use <slug>` writes `active_workspace: <slug>` into the
 *   caller's ~/.ark/config.yaml. The target is a file on the CLI host, not
 *   the daemon. We therefore keep it on `getInProcessApp()` and refuse to
 *   run it in remote mode.
 *
 *   `ark workspace add-repo <slug> <path>` for a *new* local path: the
 *   previous implementation auto-registered the repo on the fly. The new
 *   RPC surface makes that a two-step operation (`code-intel repo add`
 *   followed by `workspace add-repo`). The CLI performs the two RPCs in
 *   sequence so the UX stays identical.
 */

import type { Command } from "commander";
import chalk from "chalk";
import YAML from "yaml";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { getArkClient, getInProcessApp, isRemoteMode } from "../app-client.js";

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

export function registerWorkspaceCommands(program: Command) {
  const cmd = program.command("workspace").description("Manage workspaces (tenant -> workspace -> repo)");

  // ── create ──────────────────────────────────────────────────────────────
  cmd
    .command("create")
    .description("Create a new workspace")
    .argument("<slug>", "Workspace slug (unique per tenant)")
    .option("--tenant <slug>", "Tenant slug (default: caller's tenant)")
    .option("--name <name>", "Display name (default: derived from slug)")
    .option("--description <text>", "Free-form description")
    .action(async (slug: string, opts) => {
      if (opts.tenant) {
        console.log(
          chalk.yellow("--tenant is no longer honored at the CLI; the daemon uses the caller's authenticated tenant."),
        );
      }
      try {
        const client = await getArkClient();
        const { workspace: created, created: wasCreated } = await client.workspaceCreate({
          slug,
          name: opts.name,
          description: opts.description ?? null,
        });
        if (!wasCreated) {
          console.log(chalk.yellow(`Workspace '${slug}' already exists (${created.id.slice(0, 8)})`));
          return;
        }
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
    .option("--tenant <slug>", "Tenant slug (default: caller's tenant)")
    .option("--format <fmt>", "Output format: yaml | text", "text")
    .action(async (opts) => {
      if (opts.tenant) {
        console.log(
          chalk.yellow("--tenant is no longer honored at the CLI; the daemon uses the caller's authenticated tenant."),
        );
      }
      try {
        const client = await getArkClient();
        const { workspaces } = await client.workspaceList();
        if (opts.format === "yaml") {
          console.log(YAML.stringify(workspaces));
          return;
        }
        if (workspaces.length === 0) {
          console.log(chalk.dim("No workspaces. Create one with `ark workspace create <slug>`."));
          return;
        }
        for (const w of workspaces) {
          console.log(
            `  ${chalk.cyan(w.slug.padEnd(20))} ${chalk.bold(w.name.padEnd(24))} ${chalk.dim(
              `${w.repo_count} repo${w.repo_count === 1 ? "" : "s"}`,
            )}`,
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
    .option("--tenant <slug>", "Tenant slug (default: caller's tenant)")
    .option("--format <fmt>", "Output format: yaml | text", "text")
    .action(async (slug: string, opts) => {
      if (opts.tenant) {
        console.log(
          chalk.yellow("--tenant is no longer honored at the CLI; the daemon uses the caller's authenticated tenant."),
        );
      }
      try {
        const client = await getArkClient();
        const { workspace: ws } = await client.workspaceGet(slug);
        if (opts.format === "yaml") {
          console.log(YAML.stringify(ws));
          return;
        }
        console.log(chalk.bold(ws.name));
        console.log(`  ${chalk.dim("slug")}        ${ws.slug}`);
        console.log(`  ${chalk.dim("id")}          ${ws.id}`);
        if (ws.description) console.log(`  ${chalk.dim("description")} ${ws.description}`);
        console.log(`  ${chalk.dim("created")}     ${ws.created_at}`);
        console.log(`  ${chalk.dim("repos")}       ${ws.repos.length}`);
        for (const r of ws.repos) {
          console.log(`    ${chalk.cyan(r.id.slice(0, 8))} ${chalk.bold(r.name)} ${chalk.dim(r.repo_url)}`);
        }
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exitCode = 1;
      }
    });

  // ── use (local-by-nature) ───────────────────────────────────────────────
  cmd
    .command("use")
    .description("Set the active workspace (persisted to the caller's ~/.ark/config.yaml)")
    .argument("<slug>", "Workspace slug")
    .option("--tenant <slug>", "Tenant slug (default: caller's tenant)")
    .action(async (slug: string, opts) => {
      if (opts.tenant) {
        console.log(
          chalk.yellow("--tenant is no longer honored at the CLI; the daemon uses the caller's authenticated tenant."),
        );
      }
      try {
        // Verify the workspace exists via the daemon first -- this way we
        // don't write a stale slug into the local config when the caller
        // typo'd the name.
        const client = await getArkClient();
        const { workspace: ws } = await client.workspaceGet(slug);

        // We need the caller's arkDir for the config.yaml write. In remote
        // mode we still persist to the caller's local config, so grab it
        // from loadConfig() directly (no AppContext boot needed).
        let arkDir: string;
        if (isRemoteMode()) {
          const { loadConfig } = await import("../../core/config.js");
          arkDir = loadConfig().arkDir;
        } else {
          const app = await getInProcessApp();
          arkDir = app.config.arkDir;
        }
        const written = setActiveWorkspaceInConfig(arkDir, ws.slug);
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
    .option("--tenant <slug>", "Tenant slug (default: caller's tenant)")
    .action(async (workspaceSlug: string, repoArg: string, opts) => {
      if (opts.tenant) {
        console.log(
          chalk.yellow("--tenant is no longer honored at the CLI; the daemon uses the caller's authenticated tenant."),
        );
      }
      try {
        const client = await getArkClient();

        // Try direct attach first -- if the repo already exists in the
        // tenant (by id / name / url) the daemon will resolve it.
        try {
          await client.workspaceAddRepo({ slug: workspaceSlug, repo: repoArg });
          console.log(chalk.green(`Attached '${repoArg}' to workspace '${workspaceSlug}'`));
          return;
        } catch (e: any) {
          // Fall through only if the daemon said the repo was not found --
          // other errors (e.g. workspace missing) should bubble up.
          if (!String(e?.message ?? "").includes("not found in this tenant")) {
            throw e;
          }
        }

        // Fall back: auto-register the repo, then attach. Mirrors the old
        // behavior of `ark workspace add-repo <new-path>`.
        const isLocal = existsSync(repoArg);
        const repoUrl = isLocal ? `file://${resolve(repoArg)}` : repoArg;
        const derivedName = (isLocal ? resolve(repoArg).split("/").pop() : repoArg.split("/").pop()) ?? "repo";
        const { repo: created } = await client.codeIntelRepoAdd({
          repoUrl,
          name: derivedName,
          localPath: isLocal ? resolve(repoArg) : null,
        });
        await client.workspaceAddRepo({ slug: workspaceSlug, repo: created.id });
        console.log(
          chalk.green(`Attached '${created.name}' (${created.id.slice(0, 8)}) to workspace '${workspaceSlug}'`),
        );
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
    .option("--tenant <slug>", "Tenant slug (default: caller's tenant)")
    .action(async (workspaceSlug: string, repoArg: string, opts) => {
      if (opts.tenant) {
        console.log(
          chalk.yellow("--tenant is no longer honored at the CLI; the daemon uses the caller's authenticated tenant."),
        );
      }
      try {
        const client = await getArkClient();
        const result = await client.workspaceRemoveRepo({ slug: workspaceSlug, repo: repoArg });
        if (!result.detached) {
          console.log(
            chalk.yellow(`Repo '${repoArg}' is not attached to workspace '${workspaceSlug}'; nothing to do.`),
          );
          return;
        }
        console.log(chalk.green(`Detached '${repoArg}' from workspace '${workspaceSlug}'`));
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exitCode = 1;
      }
    });
}
