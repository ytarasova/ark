import type { Command } from "commander";
import chalk from "chalk";
import * as core from "../../core/index.js";
import { getArkClient } from "./_shared.js";

export function registerSearchCommands(program: Command) {
  program
    .command("search")
    .description("Search across sessions, events, messages, and transcripts")
    .argument("<query>", "Search text (case-insensitive)")
    .option("-l, --limit <n>", "Max results", "20")
    .option("-t, --transcripts", "Also search Claude transcripts (slower)")
    .option("--index", "Rebuild transcript search index before searching")
    .option("--hybrid", "Use hybrid search (memory + knowledge + transcripts with LLM re-ranking)")
    .action(async (query, opts) => {
      const ark = await getArkClient();
      if (opts.index) {
        console.log(chalk.dim("Indexing transcripts..."));
        await ark.historyIndex();
        const { stats } = await ark.indexStats();
        console.log(chalk.green(`Indexed entries from ${stats?.sessions ?? 0} sessions\n`));
      }

      const limit = parseInt(opts.limit);
      const results = await ark.sessionSearch(query);

      if (opts.transcripts) {
        const transcriptResults = await ark.historySearch(query, limit);
        results.push(...transcriptResults);
      }

      if (opts.hybrid) {
        const app = core.getApp();
        const knowledgeResults = app.knowledge.search(query, { limit });
        if (knowledgeResults.length === 0) {
          console.log(chalk.yellow("No knowledge search results found."));
          return;
        }
        console.log(chalk.bold(`Found ${knowledgeResults.length} result(s) via knowledge search for "${query}":\n`));
        for (const r of knowledgeResults) {
          const sourceColor =
            r.type === "memory"
              ? chalk.blue
              : r.type === "learning"
                ? chalk.cyan
                : r.type === "session"
                  ? chalk.magenta
                  : chalk.green;
          const score = chalk.dim(`(${r.score.toFixed(2)})`);
          const text = r.content ?? r.label;
          const content = text.length > 120 ? text.slice(0, 120) + "..." : text;
          console.log(`  ${sourceColor(`[${r.type}]`)} ${score}  ${content}`);
        }
        return;
      }

      if (results.length === 0) {
        console.log(chalk.yellow("No results found."));
        return;
      }

      console.log(chalk.bold(`Found ${results.length} result(s) for "${query}":\n`));
      for (const r of results) {
        const sourceColor =
          r.source === "metadata"
            ? chalk.blue
            : r.source === "event"
              ? chalk.cyan
              : r.source === "message"
                ? chalk.green
                : chalk.magenta;
        const match = r.match.length > 120 ? r.match.slice(0, 120) + "..." : r.match;
        console.log(`  ${chalk.dim(r.sessionId)}  ${sourceColor(`[${r.source}]`)}  ${match}`);
      }
    });

  program
    .command("index")
    .description("Build or rebuild the transcript search index")
    .action(async () => {
      const ark = await getArkClient();
      console.log(chalk.dim("Indexing transcripts..."));
      const result = await ark.historyIndex();
      const { stats } = await ark.indexStats();
      console.log(chalk.green(`Indexed ${result.count ?? 0} entries from ${stats?.sessions ?? 0} sessions`));
    });

  program
    .command("search-all")
    .description("Search across all Claude conversations")
    .argument("<query>")
    .option("-n, --limit <n>", "Max results", "20")
    .option("--days <n>", "Recent days to search", "90")
    .action((query: string, opts: { limit: string; days: string }) => {
      const results = core.searchAllConversations(query, {
        maxResults: Number(opts.limit),
        recentDays: Number(opts.days),
      });
      if (results.length === 0) {
        console.log(chalk.dim("No results"));
        return;
      }
      for (const r of results) {
        console.log(`${chalk.cyan(r.projectName)} ${chalk.dim(r.fileName)}`);
        console.log(`  ${r.matchLine.slice(0, 100)}`);
      }
    });
}
