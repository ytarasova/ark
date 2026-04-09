import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync, statSync } from "fs";
import * as core from "../../core/index.js";
import { getArkClient } from "./_shared.js";

export function registerMemoryCommands(program: Command) {
  const memoryCmd = program.command("memory").description("Manage cross-session memory");

  memoryCmd.command("list")
    .description("List stored memories")
    .option("-s, --scope <scope>", "Filter by scope")
    .action(async (opts) => {
      const ark = await getArkClient();
      const memories = await ark.memoryList(opts.scope);
      if (!memories.length) {
        console.log(chalk.dim("No memories stored."));
        return;
      }
      for (const m of memories) {
        const tags = m.tags.length ? chalk.dim(` [${m.tags.join(", ")}]`) : "";
        const scope = chalk.dim(`(${m.scope})`);
        console.log(`  ${m.id}  ${scope} ${m.content.slice(0, 60)}${m.content.length > 60 ? "..." : ""}${tags}`);
      }
      console.log(chalk.dim(`\n${memories.length} memories total`));
    });

  memoryCmd.command("recall")
    .description("Recall memories relevant to a query")
    .argument("<query>", "Search query")
    .option("-s, --scope <scope>", "Filter by scope")
    .option("-n, --limit <n>", "Max results", "10")
    .action(async (query: string, opts) => {
      const ark = await getArkClient();
      const results = await ark.memoryRecall(query, { scope: opts.scope, limit: Number(opts.limit) });
      if (!results.length) {
        console.log(chalk.dim("No relevant memories found."));
        return;
      }
      for (const m of results) {
        const tags = m.tags.length ? chalk.dim(` [${m.tags.join(", ")}]`) : "";
        console.log(`  ${chalk.bold(m.id)}  ${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""}${tags}`);
      }
    });

  memoryCmd.command("forget")
    .description("Forget a specific memory")
    .argument("<id>", "Memory ID")
    .action(async (id: string) => {
      const ark = await getArkClient();
      const ok = await ark.memoryForget(id);
      console.log(ok ? chalk.green(`Forgot ${id}`) : chalk.red(`Memory ${id} not found`));
    });

  memoryCmd.command("add")
    .description("Store a new memory")
    .argument("<content>", "Memory content")
    .option("-t, --tags <tags>", "Comma-separated tags")
    .option("-s, --scope <scope>", "Scope (default: global)")
    .option("-i, --importance <n>", "Importance 0-1 (default: 0.5)")
    .action(async (content: string, opts: any) => {
      const ark = await getArkClient();
      const memory = await ark.memoryAdd(content, {
        tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined,
        scope: opts.scope,
        importance: opts.importance ? parseFloat(opts.importance) : undefined,
      });
      console.log(chalk.green(`Remembered: ${memory.id}`));
      if (memory.tags.length) console.log(chalk.dim(`Tags: ${memory.tags.join(", ")}`));
    });

  memoryCmd.command("clear")
    .description("Clear all memories in a scope")
    .option("-s, --scope <scope>", "Scope to clear (omit for ALL)")
    .option("--force", "Skip confirmation")
    .action(async (opts: any) => {
      const ark = await getArkClient();
      if (!opts.force) {
        const label = opts.scope ? `scope '${opts.scope}'` : "ALL memories";
        console.log(chalk.yellow(`This will delete ${label}. Use --force to confirm.`));
        return;
      }
      const count = await ark.memoryClear(opts.scope);
      console.log(chalk.green(`Cleared ${count} memories`));
    });

  // Knowledge commands (grouped under memory domain)
  const knowledgeCmd = program.command("knowledge").description("Knowledge ingestion");

  knowledgeCmd.command("ingest")
    .description("Ingest files into the knowledge base")
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
