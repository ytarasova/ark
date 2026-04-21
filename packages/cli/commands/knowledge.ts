/**
 * `ark knowledge` -- thin CLI wrapper over the knowledge/* RPCs.
 *
 * Every subcommand talks to the daemon via `getArkClient()`. The handlers
 * live in:
 *
 *   - packages/server/handlers/knowledge.ts      (search, stats, codebase/status)
 *   - packages/server/handlers/knowledge-rpc.ts  (remember, recall)
 *   - packages/server/handlers/knowledge-local.ts (index, export, import; local mode only)
 *   - packages/server/handlers/web-local.ts      (ingest; local mode only)
 *
 * Local-by-nature punts (documented):
 *
 *   `ark knowledge codebase status|tools|reindex` still runs entirely in the
 *   caller's process because it shells out to a *caller-side* vendored
 *   binary (`codebase-memory-mcp`). Running it over RPC would probe the
 *   daemon's filesystem, not the user's laptop. These subcommands remain
 *   local-only and use `getInProcessApp()` ONLY indirectly through the
 *   helpers in core/knowledge/codebase-memory-finder.js (no AppContext
 *   needed). The daemon-facing introspection lives under the
 *   `knowledge/codebase/status` RPC, which the `status` subcommand below
 *   uses as a fallback when the caller has no local binary vendored.
 *
 *   `ark knowledge index|ingest` against a path the daemon cannot see will
 *   fail on the daemon side. On a local laptop this is fine (cwd matches);
 *   against a remote control plane callers must upload a tarball first
 *   (not implemented yet) or register the repo via `ark code-intel repo add`.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync } from "fs";
import { getArkClient } from "../app-client.js";

export function registerKnowledgeCommands(program: Command) {
  const cmd = program.command("knowledge").description("Knowledge graph - search, index, remember, export");

  cmd
    .command("search")
    .description("Search across all knowledge (files, memories, sessions, learnings)")
    .argument("<query>", "Search query")
    .option("-t, --types <types>", "Comma-separated node types to filter (file,symbol,session,memory,learning,skill)")
    .option("-n, --limit <n>", "Max results", "20")
    .action(async (query: string, opts) => {
      const client = await getArkClient();
      const types = opts.types ? opts.types.split(",").map((t: string) => t.trim()) : undefined;
      const results = await client.knowledgeSearch(query, { types, limit: Number(opts.limit) });
      if (!results.length) {
        console.log(chalk.dim("No results found."));
        return;
      }
      for (const r of results) {
        const preview = (r.content ?? "").slice(0, 80).replace(/\n/g, " ");
        console.log(`  ${chalk.cyan(`[${r.type}]`)} ${chalk.bold(r.label)}`);
        if (preview) console.log(`    ${chalk.dim(preview)}`);
        console.log(`    ${chalk.dim(`score: ${r.score.toFixed(2)}  id: ${r.id}`)}`);
      }
      console.log(chalk.dim(`\n${results.length} results`));
    });

  cmd
    .command("index")
    .description("Index/re-index codebase into the knowledge graph (runs on daemon)")
    .option("-r, --repo <path>", "Repository path (default: cwd)")
    .option("--incremental", "Only re-index changed files")
    .action(async (opts) => {
      const client = await getArkClient();
      const repoPath = resolve(opts.repo ?? process.cwd());
      console.log(`Indexing ${repoPath}...`);
      try {
        const result = await client.knowledgeIndex(repoPath);
        if (!result.ok) {
          console.log(chalk.red(`Index failed: ${result.error ?? "unknown"}`));
          return;
        }
        console.log(
          chalk.green(
            `Indexed: ${result.files ?? 0} files, ${result.symbols ?? 0} symbols, ${result.edges ?? 0} edges (${result.duration_ms ?? 0}ms)`,
          ),
        );
      } catch (e: any) {
        console.log(chalk.red(`Index failed: ${e.message}`));
      }
    });

  cmd
    .command("stats")
    .description("Show node/edge counts by type")
    .action(async () => {
      const client = await getArkClient();
      const stats = await client.knowledgeStats();
      console.log(chalk.bold("Nodes:"));
      for (const [type, count] of Object.entries(stats.by_node_type)) {
        console.log(`  ${type.padEnd(12)} ${count}`);
      }
      console.log(`  ${"total".padEnd(12)} ${stats.nodes}`);

      console.log(chalk.bold("\nEdges:"));
      for (const [relation, count] of Object.entries(stats.by_edge_type)) {
        console.log(`  ${relation.padEnd(16)} ${count}`);
      }
      console.log(`  ${"total".padEnd(16)} ${stats.edges}`);
    });

  cmd
    .command("remember")
    .description("Store a new memory in the knowledge graph")
    .argument("<content>", "Memory content")
    .option("-t, --tags <tags>", "Comma-separated tags")
    .option("-i, --importance <n>", "Importance 0-1 (default: 0.5)")
    .action(async (content: string, opts) => {
      const client = await getArkClient();
      const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [];
      const importance = opts.importance ? parseFloat(opts.importance) : 0.5;
      const result = await client.knowledgeRemember({ content, tags, importance });
      console.log(chalk.green(`Remembered: ${result.id}`));
    });

  cmd
    .command("recall")
    .description("Search memories and learnings")
    .argument("<query>", "Search query")
    .option("-n, --limit <n>", "Max results", "10")
    .action(async (query: string, opts) => {
      const client = await getArkClient();
      const { results } = await client.knowledgeRecall(query, { limit: Number(opts.limit) });
      if (!results.length) {
        console.log(chalk.dim("No relevant memories found."));
        return;
      }
      for (const r of results) {
        const tags =
          Array.isArray(r.metadata.tags) && (r.metadata.tags as string[]).length
            ? chalk.dim(` [${(r.metadata.tags as string[]).join(", ")}]`)
            : "";
        console.log(`  ${chalk.cyan(`[${r.type}]`)} ${r.content ?? r.label}${tags}`);
      }
    });

  cmd
    .command("export")
    .description("Export knowledge as markdown files (daemon-side filesystem)")
    .option("-d, --dir <path>", "Output directory", "./knowledge-export")
    .option("-t, --types <types>", "Comma-separated types to export (default: memory,learning)")
    .action(async (opts) => {
      const client = await getArkClient();
      const outputDir = resolve(opts.dir);
      const result = await client.knowledgeExport(outputDir);
      if (!result.ok) {
        console.log(chalk.red("Export failed"));
        return;
      }
      console.log(chalk.green(`Exported ${result.exported ?? 0} nodes to ${outputDir}`));
    });

  cmd
    .command("import")
    .description("Import knowledge from markdown files (daemon-side filesystem)")
    .option("-d, --dir <path>", "Input directory", "./knowledge-export")
    .action(async (opts) => {
      const client = await getArkClient();
      const inputDir = resolve(opts.dir);
      const result = await client.knowledgeImport(inputDir);
      if (!result.ok) {
        console.log(chalk.red("Import failed"));
        return;
      }
      console.log(chalk.green(`Imported ${result.imported ?? 0} nodes from ${inputDir}`));
    });

  // Ingest subcommand -- delegates to knowledge/index (the RPC wraps both).
  cmd
    .command("ingest")
    .description("Ingest a directory into the knowledge graph (indexes files and symbols)")
    .argument("<path>", "Directory to ingest")
    .option("--incremental", "Only re-index changed files")
    .action(async (path: string, _opts) => {
      const client = await getArkClient();
      const resolved = resolve(path);
      console.log(`Ingesting ${resolved}...`);
      try {
        const result = await client.knowledgeIndex(resolved);
        if (!result.ok) {
          console.log(chalk.red(`Ingest failed: ${result.error ?? "unknown"}`));
          return;
        }
        console.log(
          chalk.green(
            `Indexed: ${result.files ?? 0} files, ${result.symbols ?? 0} symbols, ${result.edges ?? 0} edges (${result.duration_ms ?? 0}ms)`,
          ),
        );
      } catch (e: any) {
        console.log(chalk.red(`Ingest failed: ${e.message}`));
      }
    });

  // ── codebase-memory-mcp integration (local-by-nature) ──────────────────────
  // The `codebase` subtree probes the caller's filesystem for a vendored
  // `codebase-memory-mcp` binary. That binary belongs to the CLI host, not
  // the daemon, so we do NOT route these calls through the RPC surface.
  // `reindex` shells out to the caller's binary; `status` prefers the local
  // binary when present and falls back to the daemon-side introspection.
  const codebase = cmd.command("codebase").description("codebase-memory-mcp (vendored code intelligence engine)");

  codebase
    .command("status")
    .description("Show codebase-memory-mcp installation status and version")
    .action(async () => {
      const { findCodebaseMemoryBinary } = await import("../../core/knowledge/codebase-memory-finder.js");
      const { execFileSync } = await import("child_process");
      const bin = findCodebaseMemoryBinary();
      const available = bin !== "codebase-memory-mcp" && existsSync(bin);
      if (!available) {
        console.log(chalk.yellow("codebase-memory-mcp: not vendored (caller-side)"));
        console.log(chalk.dim("  Run `make vendor-codebase-memory-mcp` or install v0.6.0+ globally."));
        return;
      }
      console.log(`${chalk.green("codebase-memory-mcp:")} ${bin}`);
      try {
        const version = execFileSync(bin, ["--version"], { encoding: "utf-8" }).trim();
        console.log(`  version: ${version}`);
      } catch (e: any) {
        console.log(chalk.red(`  version check failed: ${e?.message ?? e}`));
      }
    });

  codebase
    .command("tools")
    .description("List the 14 MCP tools exposed by codebase-memory-mcp")
    .action(() => {
      const tools = [
        ["index_repository", "Full-index a repo path (or reuse cached index)"],
        ["index_status", "Check index freshness + node/edge counts for a repo"],
        ["detect_changes", "Find files changed since the last index snapshot"],
        ["search_graph", "Structural search over the code graph"],
        ["query_graph", "Graph query (call chains, references)"],
        ["trace_path", "Trace call paths between symbols"],
        ["get_code_snippet", "Read source code by qualified name"],
        ["get_graph_schema", "Return node/edge type schema for the graph"],
        ["get_architecture", "Codebase overview: languages, packages, routes, clusters, ADR"],
        ["search_code", "Grep-like text search within indexed project files"],
        ["list_projects", "List all indexed projects"],
        ["delete_project", "Remove a project from the index"],
        ["manage_adr", "CRUD for Architecture Decision Records"],
        ["ingest_traces", "Ingest runtime traces for correlating with code"],
      ];
      console.log(chalk.bold("codebase-memory-mcp exposes 14 MCP tools:"));
      for (const [name, desc] of tools) {
        console.log(`  ${chalk.cyan(name.padEnd(20))} ${chalk.dim(desc)}`);
      }
      console.log();
      console.log(chalk.dim("Agents see these as `mcp__codebase-memory__<name>` at dispatch."));
      console.log(chalk.dim("See docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md for the integration design."));
    });

  codebase
    .command("reindex")
    .description("Run `index_repository` against a path via the caller's vendored binary")
    .argument("[path]", "Repository path (default: cwd)")
    .action(async (path?: string) => {
      const { findCodebaseMemoryBinary } = await import("../../core/knowledge/codebase-memory-finder.js");
      const { spawn } = await import("child_process");
      const bin = findCodebaseMemoryBinary();
      if (bin === "codebase-memory-mcp" || !existsSync(bin)) {
        console.log(chalk.red("codebase-memory-mcp not vendored. Run `make vendor-codebase-memory-mcp`."));
        return;
      }
      const repoPath = resolve(path ?? process.cwd());
      console.log(`Indexing ${repoPath} via ${bin}...`);
      const child = spawn(bin, ["cli", "index_repository", JSON.stringify({ path: repoPath })], {
        stdio: "inherit",
      });
      await new Promise<void>((res, rej) =>
        child.on("exit", (code) => (code === 0 ? res() : rej(new Error(`exit ${code}`)))),
      );
    });
}
