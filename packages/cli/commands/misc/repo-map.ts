import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "path";
import * as core from "../../../core/index.js";

/** `ark repo-map [dir]` -- dump a quick structural map of a repository. */
export function registerRepoMapCommand(program: Command): void {
  program
    .command("repo-map")
    .description("Generate repository structure map")
    .argument("[dir]", "Directory to scan", ".")
    .option("--max-files <n>", "Max files to include", "500")
    .option("--max-depth <n>", "Max directory depth", "10")
    .option("--json", "Output as JSON instead of text")
    .action((dir, opts) => {
      const rootDir = resolve(dir);
      const map = core.generateRepoMap(rootDir, {
        maxFiles: Number(opts.maxFiles),
        maxDepth: Number(opts.maxDepth),
      });

      if (opts.json) {
        console.log(JSON.stringify(map, null, 2));
      } else {
        console.log(chalk.bold(`Repository map: ${rootDir}`));
        console.log(chalk.dim(`${map.totalFiles} files\n`));
        console.log(map.summary);
      }
    });
}
