/**
 * `ark code-intel` -- thin CLI wrapper over the code-intel/* RPCs.
 *
 * RPC methods (see packages/server/handlers/code-intel.ts):
 *   code-intel/health
 *   code-intel/migration-status
 *   code-intel/migrate
 *   code-intel/reset
 *   code-intel/tenant/list
 *   code-intel/repo/add
 *   code-intel/repo/list
 *   code-intel/reindex
 *   code-intel/search
 *   code-intel/get-context
 *
 * Local-by-nature punts (documented):
 *
 *   `ark code-intel doctor` probes the *caller's* VendorResolver and local
 *   `git --version` binary. It is explicitly a host-local diagnostic; there
 *   is no sensible remote equivalent. It stays on `getInProcessApp()`.
 *
 *   `ark code-intel repo add <local-path>` accepts a filesystem path. The
 *   path is forwarded verbatim to the daemon via the RPC; if the daemon is
 *   remote and the path is caller-local, the registration succeeds but the
 *   `local_path` column records a string the daemon can't read. This is the
 *   intended behavior: the CLI does not try to tarball + upload the tree.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync } from "fs";
import { getArkClient, getInProcessApp, isRemoteMode } from "../app-client.js";
import { runGit } from "../../core/code-intel/util/git.js";

export function registerCodeIntelCommands(program: Command) {
  const cmd = program.command("code-intel").description("Unified code-intelligence store (search, index, repos, runs)");

  // ── db ──────────────────────────────────────────────────────────────────
  const db = cmd.command("db").description("Schema migrations + status");

  db.command("migrate")
    .description("Apply any pending code-intel migrations")
    .option("--to <version>", "Target version (default: latest)")
    .action(async (opts) => {
      const client = await getArkClient();
      const target = opts.to ? Number(opts.to) : undefined;
      const result = await client.codeIntelMigrate(target !== undefined ? { to: target } : {});
      console.log(chalk.green(`Applied. Current version: ${result.currentVersion}`));
    });

  db.command("status")
    .description("Print current schema version + pending migrations")
    .action(async () => {
      const client = await getArkClient();
      const status = await client.codeIntelMigrationStatus();
      console.log(`Current version: ${chalk.cyan(status.currentVersion)}`);
      if (status.pending.length === 0) {
        console.log(chalk.green("No pending migrations."));
      } else {
        console.log(chalk.yellow(`${status.pending.length} pending:`));
        for (const m of status.pending) console.log(`  ${m.version}: ${m.name}`);
      }
    });

  db.command("reset")
    .description("Drop every code-intel table (DEV ONLY).")
    .option("--yes", "Confirm destructive operation")
    .action(async (opts) => {
      if (!opts.yes) {
        console.log(chalk.red("Refusing to reset without --yes."));
        process.exitCode = 1;
        return;
      }
      const client = await getArkClient();
      await client.codeIntelReset({ confirm: true });
      console.log(chalk.yellow("Dropped all code-intel tables."));
    });

  // ── repo ────────────────────────────────────────────────────────────────
  const repo = cmd.command("repo").description("Manage indexed repositories");

  repo
    .command("add")
    .description("Register a repo for indexing")
    .argument("<url-or-path>", "Repo URL or local path")
    .option("--tenant <slug>", "Tenant slug (default: caller's tenant)")
    .option("--name <name>", "Display name (default: derived)")
    .option("--default-branch <branch>", "Default branch", "main")
    .action(async (urlOrPath: string, opts) => {
      if (opts.tenant) {
        console.log(
          chalk.yellow("--tenant is no longer honored at the CLI; the daemon uses the caller's authenticated tenant."),
        );
      }
      const client = await getArkClient();
      const isLocal = existsSync(urlOrPath);
      const local_path = isLocal ? resolve(urlOrPath) : null;
      const repoUrl = isLocal ? `file://${resolve(urlOrPath)}` : urlOrPath;
      const derivedName =
        opts.name ?? (isLocal ? resolve(urlOrPath).split("/").pop() : urlOrPath.split("/").pop()) ?? "repo";
      const { repo: created, created: wasCreated } = await client.codeIntelRepoAdd({
        repoUrl,
        name: derivedName,
        defaultBranch: opts.defaultBranch,
        localPath: local_path,
      });
      if (!wasCreated) {
        console.log(chalk.yellow(`Already registered: ${created.id} (${created.name})`));
        return;
      }
      console.log(chalk.green(`Registered ${created.name} (${created.id})`));
    });

  repo
    .command("list")
    .description("List repos for a tenant")
    .option("--tenant <slug>", "Tenant slug (default: caller's tenant)")
    .action(async (opts) => {
      if (opts.tenant) {
        console.log(
          chalk.yellow("--tenant is no longer honored at the CLI; the daemon uses the caller's authenticated tenant."),
        );
      }
      const client = await getArkClient();
      const { repos } = await client.codeIntelRepoList();
      if (repos.length === 0) {
        console.log(chalk.dim("No repos registered."));
        return;
      }
      for (const r of repos) {
        console.log(`  ${chalk.cyan(r.id.slice(0, 8))} ${chalk.bold(r.name)} ${chalk.dim(r.repo_url)}`);
      }
    });

  // ── reindex ─────────────────────────────────────────────────────────────
  cmd
    .command("reindex")
    .description("Run extractors against a repo")
    .option("--tenant <slug>", "Tenant slug (default: caller's tenant)")
    .option("--repo <id-or-name>", "Repo id or name (default: only one if unambiguous)")
    .option("--extractors <names>", "Comma-separated extractor names (default: all)")
    .action(async (opts) => {
      if (opts.tenant) {
        console.log(
          chalk.yellow("--tenant is no longer honored at the CLI; the daemon uses the caller's authenticated tenant."),
        );
      }
      const client = await getArkClient();
      const extractors = opts.extractors
        ? String(opts.extractors)
            .split(",")
            .map((s) => s.trim())
        : undefined;
      try {
        const { run } = await client.codeIntelReindex({ repoId: opts.repo, extractors });
        console.log(chalk.green(`Run ${run.id.slice(0, 8)} -- status=${run.status}`));
        for (const [name, count] of Object.entries(run.extractor_counts)) {
          console.log(`  ${name.padEnd(28)} ${chalk.cyan(String(count))}`);
        }
      } catch (e: any) {
        console.log(chalk.red(e?.message ?? "reindex failed"));
        process.exitCode = 1;
      }
    });

  // ── search ──────────────────────────────────────────────────────────────
  cmd
    .command("search")
    .description("FTS over chunks (file content + symbols)")
    .argument("<query>", "Search query")
    .option("--tenant <slug>", "Tenant slug (default: caller's tenant)")
    .option("-n, --limit <n>", "Max results", "20")
    .action(async (query: string, opts) => {
      const client = await getArkClient();
      const { hits } = await client.codeIntelSearch(query, { limit: Number(opts.limit) });
      if (hits.length === 0) {
        console.log(chalk.dim("No matches."));
        return;
      }
      for (const h of hits) {
        console.log(
          `  ${chalk.cyan(h.chunk_id.slice(0, 8))} ${chalk.dim(h.chunk_kind)} ${String(h.content_preview).replace(/\n/g, " ")}`,
        );
      }
      console.log(chalk.dim(`\n${hits.length} results`));
    });

  // ── get-context ─────────────────────────────────────────────────────────
  cmd
    .command("get-context")
    .description("Assemble a context snapshot for a file or symbol")
    .argument("<subject>", "File path, file id, or symbol name")
    .option("--tenant <slug>", "Tenant slug (default: caller's tenant)")
    .option("--repo <id-or-name>", "Repo id or name (helps path lookup)")
    .action(async (subject: string, opts) => {
      const client = await getArkClient();
      const { context: result } = await client.codeIntelGetContext({ subject, repoId: opts.repo });
      if (!result || !result.file) {
        console.log(chalk.dim("No matching file."));
        return;
      }
      console.log(chalk.bold(result.file.path));
      console.log(chalk.dim(`  language=${result.file.language ?? "?"}  size=${result.file.size_bytes ?? 0}`));
      console.log(chalk.bold(`Symbols (${result.symbols_in_file.length}):`));
      for (const s of result.symbols_in_file.slice(0, 10)) {
        console.log(`  ${chalk.cyan(s.kind)} ${s.name} ${chalk.dim(`${s.line_start}-${s.line_end}`)}`);
      }
      console.log(chalk.bold(`Contributors (${result.top_contributors.length}):`));
      for (const c of result.top_contributors) {
        console.log(`  ${c.person_id} commits=${c.commit_count} +${c.loc_added}/-${c.loc_removed}`);
      }
      console.log(chalk.bold(`Dependents: ${result.dependents_count}`));
    });

  // ── doctor (local-by-nature) ────────────────────────────────────────────
  // Doctor inspects the caller's host: VendorResolver binary table + local
  // git. Running it over RPC would only report the daemon's state, which is
  // rarely the thing the user wants to know. Stays on `getInProcessApp()`.
  cmd
    .command("doctor")
    .description("Report VendorResolver + binary health (caller-local)")
    .action(async () => {
      if (isRemoteMode()) {
        console.log(
          chalk.yellow(
            "`code-intel doctor` inspects the caller's local binaries, which is not available against a remote --server.",
          ),
        );
        process.exitCode = 1;
        return;
      }
      const app = await getInProcessApp();
      const list = app.deployment.vendorResolver.listInstalled();
      for (const v of list) {
        const tag = v.ok ? chalk.green("ok") : chalk.red("missing");
        console.log(`  ${tag} ${v.name.padEnd(32)} ${chalk.dim(v.path ?? v.reason ?? "")}`);
      }
      const git = runGit(process.cwd(), ["--version"]);
      console.log(
        `  ${git.ok ? chalk.green("ok") : chalk.red("missing")} ${"git".padEnd(32)} ${chalk.dim(git.stdout.trim() || git.stderr.trim())}`,
      );
    });

  // ── health ──────────────────────────────────────────────────────────────
  cmd
    .command("health")
    .description("High-level store + deployment health")
    .action(async () => {
      const client = await getArkClient();
      const h = await client.codeIntelHealth();
      console.log(chalk.bold("Code-intel health"));
      console.log(`  schema version: ${chalk.cyan(h.schemaVersion)} (pending: ${h.pending})`);
      console.log(`  deployment mode: ${chalk.cyan(h.deploymentMode)}`);
      console.log(`  store backend: ${chalk.cyan(h.storeBackend)}`);
      console.log(`  tenants: ${chalk.cyan(h.tenantCount)}`);
      console.log(`  repos (default tenant): ${chalk.cyan(h.defaultTenantRepoCount)}`);
      console.log(`  feature flag codeIntelV2: ${h.featureCodeIntelV2 ? chalk.green("on") : chalk.dim("off")}`);
    });
}
