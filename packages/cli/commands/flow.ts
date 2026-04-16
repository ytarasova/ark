import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import YAML from "yaml";
import { getArkClient } from "./_shared.js";

export function registerFlowCommands(program: Command) {
  const pipe = program.command("flow").description("Manage flows");

  pipe
    .command("list")
    .description("List flows")
    .action(async () => {
      const ark = await getArkClient();
      const flows = await ark.flowList();
      for (const p of flows) {
        console.log(`  ${p.name.padEnd(16)} ${p.stages.join(" > ")}  ${chalk.dim(p.description.slice(0, 40))}`);
      }
    });

  pipe
    .command("show")
    .description("Show flow")
    .argument("<name>")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        const p = await ark.flowRead(name);
        console.log(chalk.bold(`\n${p.name}`));
        if (p.description) console.log(chalk.dim(`  ${p.description}`));
        for (const [i, s] of p.stages.entries()) {
          const type = s.type ?? (s.action ? "action" : "agent");
          const detail = s.agent ?? s.action ?? "";
          console.log(
            `  ${i + 1}. ${s.name.padEnd(14)} [${type}:${detail}] gate=${s.gate}${s.optional ? " (optional)" : ""}`,
          );
        }
      } catch {
        console.log(chalk.red("Not found"));
      }
    });

  pipe
    .command("create")
    .description("Create a flow from a YAML file")
    .argument("<name>", "Flow name")
    .option("--from <file>", "YAML file containing the stages array")
    .option("--description <text>", "Flow description")
    .option("--scope <scope>", "global or project", "global")
    .action(async (name: string, opts: { from?: string; description?: string; scope?: string }) => {
      const ark = await getArkClient();
      let stages: unknown[] = [];
      let description = opts.description ?? "";
      if (opts.from) {
        const file = resolve(opts.from);
        if (!existsSync(file)) {
          console.log(chalk.red(`File not found: ${file}`));
          process.exit(1);
        }
        const parsed = YAML.parse(readFileSync(file, "utf-8")) as { stages?: unknown[]; description?: string };
        stages = parsed?.stages ?? [];
        if (!description && parsed?.description) description = parsed.description;
      }
      if (!Array.isArray(stages) || stages.length === 0) {
        console.log(chalk.red("No stages provided. Pass --from <file.yaml> with a 'stages:' array."));
        process.exit(1);
      }
      try {
        const result = await ark.flowCreate({
          name,
          description,
          stages: stages as never,
          scope: (opts.scope as "global" | "project") ?? "global",
        });
        console.log(chalk.green(`Created flow '${result.name}'`));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(chalk.red(`Failed: ${msg}`));
        process.exit(1);
      }
    });

  pipe
    .command("delete")
    .description("Delete a flow (global or project only -- builtins are protected)")
    .argument("<name>", "Flow name")
    .option("--scope <scope>", "global or project", "global")
    .action(async (name: string, opts: { scope?: string }) => {
      const ark = await getArkClient();
      try {
        const result = await ark.flowDelete(name, (opts.scope as "global" | "project") ?? "global");
        if (result.ok) console.log(chalk.green(`Deleted flow '${name}'`));
        else console.log(chalk.red(`Flow '${name}' not found`));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(chalk.red(`Failed: ${msg}`));
        process.exit(1);
      }
    });
}
