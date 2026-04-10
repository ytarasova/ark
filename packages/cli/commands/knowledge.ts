import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync, statSync } from "fs";
import * as core from "../../core/index.js";

export function registerKnowledgeCommands(program: Command) {
  const cmd = program.command("knowledge").description("Knowledge graph - search, index, remember, export");

  cmd.command("search")
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

  cmd.command("index")
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
        console.log(chalk.green(`Indexed: ${result.files} files, ${result.symbols} symbols, ${result.edges} edges (${result.duration_ms}ms)`));
      } catch (e: any) {
        console.log(chalk.red(`Index failed: ${e.message}`));
      }
    });

  cmd.command("stats")
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

      const edgeTypes = ["depends_on", "imports", "modified_by", "learned_from", "relates_to", "uses", "extracted_from", "co_changes"] as const;
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

  cmd.command("remember")
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

  cmd.command("recall")
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
        const tags = Array.isArray(r.metadata.tags) && r.metadata.tags.length
          ? chalk.dim(` [${(r.metadata.tags as string[]).join(", ")}]`)
          : "";
        console.log(`  ${chalk.cyan(`[${r.type}]`)} ${r.content ?? r.label}${tags}`);
      }
    });

  cmd.command("export")
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

  cmd.command("import")
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

  // Preserve the legacy ingest subcommand
  cmd.command("ingest")
    .description("Ingest files into the knowledge base (legacy)")
    .argument("<path>", "File or directory to ingest")
    .option("-s, --scope <scope>", "Scope for ingested knowledge", "knowledge")
    .option("-t, --tag <tag>", "Tag (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
    .action((path: string, opts) => {
      const resolved = resolve(path);
      if (!existsSync(resolved)) {
        console.log(chalk.red(`Path not found: ${resolved}`));
        return;
      }
      const stat = statSync(resolved);
      if (stat.isDirectory()) {
        const result = core.ingestDirectory(core.getApp(), resolved, { scope: opts.scope, tags: opts.tag });
        console.log(chalk.green(`Ingested ${result.files} files (${result.chunks} chunks) from ${resolved}`));
      } else {
        const chunks = core.ingestFile(core.getApp(), resolved, { scope: opts.scope, tags: opts.tag });
        console.log(chunks > 0
          ? chalk.green(`Ingested ${resolved} (${chunks} chunks)`)
          : chalk.yellow(`Skipped ${resolved} (unsupported or empty)`));
      }
    });
}
