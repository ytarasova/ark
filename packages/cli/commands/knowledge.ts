import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync } from "fs";
import * as core from "../../core/index.js";

export function registerKnowledgeCommands(program: Command) {
  const cmd = program.command("knowledge").description("Knowledge graph - search, index, remember, export");

  cmd
    .command("search")
    .description("Search across all knowledge (files, memories, sessions, learnings)")
    .argument("<query>", "Search query")
    .option("-t, --types <types>", "Comma-separated node types to filter (file,symbol,session,memory,learning,skill)")
    .option("-n, --limit <n>", "Max results", "20")
    .action((query: string, opts) => {
      const app = core.getApp();
      const types = opts.types ? opts.types.split(",").map((t: string) => t.trim()) : undefined;
      const results = app.knowledge.search(query, { types, limit: Number(opts.limit) });
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
    .description("Index/re-index codebase into the knowledge graph")
    .option("-r, --repo <path>", "Repository path (default: cwd)")
    .option("--incremental", "Only re-index changed files")
    .action(async (opts) => {
      const app = core.getApp();
      const repoPath = resolve(opts.repo ?? process.cwd());
      if (!existsSync(repoPath)) {
        console.log(chalk.red(`Path not found: ${repoPath}`));
        return;
      }
      console.log(`Indexing ${repoPath}...`);
      try {
        const { indexCodebase } = await import("../../core/knowledge/indexer.js");
        const result = await indexCodebase(repoPath, app.knowledge, {
          incremental: opts.incremental,
        });
        console.log(
          chalk.green(
            `Indexed: ${result.files} files, ${result.symbols} symbols, ${result.edges} edges (${result.duration_ms}ms)`,
          ),
        );
      } catch (e: any) {
        console.log(chalk.red(`Index failed: ${e.message}`));
      }
    });

  cmd
    .command("stats")
    .description("Show node/edge counts by type")
    .action(() => {
      const app = core.getApp();
      const store = app.knowledge;
      const nodeTypes = ["file", "symbol", "session", "memory", "learning", "skill", "recipe", "agent"] as const;
      console.log(chalk.bold("Nodes:"));
      let totalNodes = 0;
      for (const t of nodeTypes) {
        const count = store.nodeCount(t);
        if (count > 0) {
          console.log(`  ${t.padEnd(12)} ${count}`);
          totalNodes += count;
        }
      }
      console.log(`  ${"total".padEnd(12)} ${totalNodes}`);

      const edgeTypes = [
        "depends_on",
        "imports",
        "modified_by",
        "learned_from",
        "relates_to",
        "uses",
        "extracted_from",
        "co_changes",
      ] as const;
      console.log(chalk.bold("\nEdges:"));
      let totalEdges = 0;
      for (const r of edgeTypes) {
        const count = store.edgeCount(r);
        if (count > 0) {
          console.log(`  ${r.padEnd(16)} ${count}`);
          totalEdges += count;
        }
      }
      console.log(`  ${"total".padEnd(16)} ${totalEdges}`);
    });

  cmd
    .command("remember")
    .description("Store a new memory in the knowledge graph")
    .argument("<content>", "Memory content")
    .option("-t, --tags <tags>", "Comma-separated tags")
    .option("-i, --importance <n>", "Importance 0-1 (default: 0.5)")
    .action((content: string, opts) => {
      const app = core.getApp();
      const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [];
      const importance = opts.importance ? parseFloat(opts.importance) : 0.5;
      const id = app.knowledge.addNode({
        type: "memory",
        label: content.slice(0, 100),
        content,
        metadata: { tags, importance, scope: "global" },
      });
      console.log(chalk.green(`Remembered: ${id}`));
    });

  cmd
    .command("recall")
    .description("Search memories and learnings")
    .argument("<query>", "Search query")
    .option("-n, --limit <n>", "Max results", "10")
    .action((query: string, opts) => {
      const app = core.getApp();
      const results = app.knowledge.search(query, {
        types: ["memory", "learning"],
        limit: Number(opts.limit),
      });
      if (!results.length) {
        console.log(chalk.dim("No relevant memories found."));
        return;
      }
      for (const r of results) {
        const tags =
          Array.isArray(r.metadata.tags) && r.metadata.tags.length
            ? chalk.dim(` [${(r.metadata.tags as string[]).join(", ")}]`)
            : "";
        console.log(`  ${chalk.cyan(`[${r.type}]`)} ${r.content ?? r.label}${tags}`);
      }
    });

  cmd
    .command("export")
    .description("Export knowledge as markdown files")
    .option("-d, --dir <path>", "Output directory", "./knowledge-export")
    .option("-t, --types <types>", "Comma-separated types to export (default: memory,learning)")
    .action(async (opts) => {
      const app = core.getApp();
      const { exportToMarkdown } = await import("../../core/knowledge/export.js");
      const outputDir = resolve(opts.dir);
      const types = opts.types ? opts.types.split(",").map((t: string) => t.trim()) : undefined;
      const result = exportToMarkdown(app.knowledge, outputDir, { types });
      console.log(chalk.green(`Exported ${result.exported} nodes to ${outputDir}`));
    });

  cmd
    .command("import")
    .description("Import knowledge from markdown files")
    .option("-d, --dir <path>", "Input directory", "./knowledge-export")
    .action(async (opts) => {
      const app = core.getApp();
      const { importFromMarkdown } = await import("../../core/knowledge/export.js");
      const inputDir = resolve(opts.dir);
      if (!existsSync(inputDir)) {
        console.log(chalk.red(`Directory not found: ${inputDir}`));
        return;
      }
      const result = importFromMarkdown(app.knowledge, inputDir);
      console.log(chalk.green(`Imported ${result.imported} nodes from ${inputDir}`));
    });

  // Ingest subcommand -- uses knowledge indexer
  cmd
    .command("ingest")
    .description("Ingest a directory into the knowledge graph (indexes files and symbols)")
    .argument("<path>", "Directory to ingest")
    .option("--incremental", "Only re-index changed files")
    .action(async (path: string, opts) => {
      const resolved = resolve(path);
      if (!existsSync(resolved)) {
        console.log(chalk.red(`Path not found: ${resolved}`));
        return;
      }
      const app = core.getApp();
      console.log(`Ingesting ${resolved}...`);
      try {
        const { indexCodebase } = await import("../../core/knowledge/indexer.js");
        const result = await indexCodebase(resolved, app.knowledge, {
          incremental: opts.incremental,
        });
        console.log(
          chalk.green(
            `Indexed: ${result.files} files, ${result.symbols} symbols, ${result.edges} edges (${result.duration_ms}ms)`,
          ),
        );
      } catch (e: any) {
        console.log(chalk.red(`Ingest failed: ${e.message}`));
      }
    });

  // ── codebase-memory-mcp integration ─────────────────────────────────────────
  // `ark knowledge codebase` exposes the vendored DeusData/codebase-memory-mcp
  // binary for introspection: is it installed, what tools does it expose,
  // trigger a reindex on a path. Agents call it directly via MCP at dispatch.
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
        console.log(chalk.yellow("codebase-memory-mcp: not vendored"));
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
    .description("Run `index_repository` against a path via the binary's CLI mode")
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
