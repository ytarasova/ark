/**
 * `ark code-intel` -- Wave 1 CLI surface for the unified code-intel store.
 *
 * Subcommands:
 *   db migrate / db status / db reset --yes (dev only)
 *   repo add <url-or-path> [--tenant X]
 *   reindex [--repo R] [--extractors a,b,c]
 *   search <query>
 *   get-context <file-or-symbol>
 *   doctor              (vendor resolver state)
 *   health              (rolled-up store + vendor health)
 *
 * The legacy `ark knowledge *` tree is unchanged. This new tree co-exists
 * until the v2 flag flips on.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync } from "fs";
import type { AppContext } from "../../core/app.js";
import { CodeIntelPipeline } from "../../core/code-intel/pipeline.js";
import { WAVE1_EXTRACTORS } from "../../core/code-intel/extractors/index.js";
import { searchQuery } from "../../core/code-intel/queries/search.js";
import { getContextQuery } from "../../core/code-intel/queries/get-context.js";
import { DEFAULT_TENANT_ID } from "../../core/code-intel/constants.js";
import { runGit } from "../../core/code-intel/util/git.js";

function resolveTenantId(app: AppContext, explicitSlug?: string | null): string {
  // Explicit --tenant; otherwise the configured default; else the seeded local tenant.
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

export function registerCodeIntelCommands(program: Command, app: AppContext) {
  const cmd = program.command("code-intel").description("Unified code-intelligence store (search, index, repos, runs)");

  // ── db ──────────────────────────────────────────────────────────────────
  const db = cmd.command("db").description("Schema migrations + status");

  db.command("migrate")
    .description("Apply any pending code-intel migrations")
    .option("--to <version>", "Target version (default: latest)")
    .action((opts) => {
      const target = opts.to ? Number(opts.to) : undefined;
      app.codeIntel.migrate({ targetVersion: target });
      const status = app.codeIntel.migrationStatus();
      console.log(chalk.green(`Applied. Current version: ${status.currentVersion}`));
    });

  db.command("status")
    .description("Print current schema version + pending migrations")
    .action(() => {
      const status = app.codeIntel.migrationStatus();
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
    .action((opts) => {
      if (!opts.yes) {
        console.log(chalk.red("Refusing to reset without --yes."));
        process.exitCode = 1;
        return;
      }
      app.codeIntel.reset();
      console.log(chalk.yellow("Dropped all code-intel tables."));
    });

  // ── repo ────────────────────────────────────────────────────────────────
  const repo = cmd.command("repo").description("Manage indexed repositories");

  repo
    .command("add")
    .description("Register a repo for indexing")
    .argument("<url-or-path>", "Repo URL or local path")
    .option("--tenant <slug>", "Tenant slug (default: local default)")
    .option("--name <name>", "Display name (default: derived)")
    .option("--default-branch <branch>", "Default branch", "main")
    .action((urlOrPath: string, opts) => {
      const tenant_id = resolveTenantId(app, opts.tenant);
      const isLocal = existsSync(urlOrPath);
      const local_path = isLocal ? resolve(urlOrPath) : null;
      const repo_url = isLocal ? `file://${resolve(urlOrPath)}` : urlOrPath;
      const name = opts.name ?? (isLocal ? resolve(urlOrPath).split("/").pop() : urlOrPath.split("/").pop()) ?? "repo";
      const existing = app.codeIntel.findRepoByUrl(tenant_id, repo_url);
      if (existing) {
        console.log(chalk.yellow(`Already registered: ${existing.id} (${existing.name})`));
        return;
      }
      const created = app.codeIntel.createRepo({
        tenant_id,
        repo_url,
        name,
        default_branch: opts.defaultBranch,
        local_path,
      });
      console.log(chalk.green(`Registered ${created.name} (${created.id})`));
    });

  repo
    .command("list")
    .description("List repos for a tenant")
    .option("--tenant <slug>", "Tenant slug (default: local default)")
    .action((opts) => {
      const tenant_id = resolveTenantId(app, opts.tenant);
      const repos = app.codeIntel.listRepos(tenant_id);
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
    .option("--tenant <slug>", "Tenant slug (default: local default)")
    .option("--repo <id-or-name>", "Repo id or name (default: only one if unambiguous)")
    .option("--extractors <names>", "Comma-separated extractor names (default: all)")
    .action(async (opts) => {
      const tenant_id = resolveTenantId(app, opts.tenant);
      const repos = app.codeIntel.listRepos(tenant_id);
      if (repos.length === 0) {
        console.log(chalk.red("No repos registered. Use `ark code-intel repo add`."));
        return;
      }
      const target = opts.repo
        ? repos.find((r) => r.id.startsWith(opts.repo) || r.name === opts.repo)
        : repos.length === 1
          ? repos[0]
          : null;
      if (!target) {
        console.log(chalk.red("Repo ambiguous; pass --repo <id>."));
        return;
      }
      const pipeline = new CodeIntelPipeline({
        store: app.codeIntel,
        vendor: app.deployment.vendorResolver,
        extractors: WAVE1_EXTRACTORS,
      });
      const names = opts.extractors
        ? String(opts.extractors)
            .split(",")
            .map((s) => s.trim())
        : null;
      const run = names
        ? await pipeline.runSubset(tenant_id, target.id, names)
        : await pipeline.runFullIndex(tenant_id, target.id);
      console.log(chalk.green(`Run ${run.id.slice(0, 8)} -- status=${run.status}`));
      if (run.extractor_counts) {
        for (const [name, count] of Object.entries(run.extractor_counts)) {
          console.log(`  ${name.padEnd(28)} ${chalk.cyan(String(count))}`);
        }
      }
    });

  // ── search ──────────────────────────────────────────────────────────────
  cmd
    .command("search")
    .description("FTS over chunks (file content + symbols)")
    .argument("<query>", "Search query")
    .option("--tenant <slug>", "Tenant slug (default: local default)")
    .option("-n, --limit <n>", "Max results", "20")
    .action(async (query: string, opts) => {
      const tenant_id = resolveTenantId(app, opts.tenant);
      const hits = await searchQuery.run({ tenant_id, store: app.codeIntel }, { query, limit: Number(opts.limit) });
      if (hits.length === 0) {
        console.log(chalk.dim("No matches."));
        return;
      }
      for (const h of hits) {
        console.log(
          `  ${chalk.cyan(h.chunk_id.slice(0, 8))} ${chalk.dim(h.chunk_kind)} ${h.content_preview.replace(/\n/g, " ")}`,
        );
      }
      console.log(chalk.dim(`\n${hits.length} results`));
    });

  // ── get-context ─────────────────────────────────────────────────────────
  cmd
    .command("get-context")
    .description("Assemble a context snapshot for a file or symbol")
    .argument("<subject>", "File path, file id, or symbol name")
    .option("--tenant <slug>", "Tenant slug (default: local default)")
    .option("--repo <id-or-name>", "Repo id or name (helps path lookup)")
    .action(async (subject: string, opts) => {
      const tenant_id = resolveTenantId(app, opts.tenant);
      let repo_id: string | undefined;
      if (opts.repo) {
        const r = app.codeIntel.listRepos(tenant_id).find((x) => x.id.startsWith(opts.repo) || x.name === opts.repo);
        repo_id = r?.id;
      }
      const result = await getContextQuery.run({ tenant_id, store: app.codeIntel }, { subject, repo_id });
      if (!result.file) {
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

  // ── doctor ──────────────────────────────────────────────────────────────
  cmd
    .command("doctor")
    .description("Report VendorResolver + binary health")
    .action(() => {
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
    .action(() => {
      const status = app.codeIntel.migrationStatus();
      const tenants = app.codeIntel.listTenants();
      const repos = app.codeIntel.listRepos(DEFAULT_TENANT_ID);
      console.log(chalk.bold("Code-intel health"));
      console.log(`  schema version: ${chalk.cyan(status.currentVersion)} (pending: ${status.pending.length})`);
      console.log(`  deployment mode: ${chalk.cyan(app.deployment.mode)}`);
      console.log(`  store backend: ${chalk.cyan(app.deployment.storeBackend)}`);
      console.log(`  tenants: ${chalk.cyan(tenants.length)}`);
      console.log(`  repos (default tenant): ${chalk.cyan(repos.length)}`);
      console.log(
        `  feature flag codeIntelV2: ${app.config.features.codeIntelV2 ? chalk.green("on") : chalk.dim("off")}`,
      );
    });
}
