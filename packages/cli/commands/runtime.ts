import type { Command } from "commander";
import chalk from "chalk";
import { getApp } from "../../core/app.js";

export function registerRuntimeCommands(program: Command) {
  const runtime = program.command("runtime").description("Manage runtime definitions");

  runtime
    .command("list")
    .description("List available runtimes")
    .action(async () => {
      const runtimes = getApp().runtimes.list();
      if (!runtimes.length) {
        console.log(chalk.dim("No runtimes found."));
        return;
      }
      for (const r of runtimes) {
        const src = (r._source === "project" ? "P" : r._source === "global" ? "G" : "B").padEnd(2);
        const models = r.models?.map((m) => m.id).join(", ") ?? "-";
        console.log(
          `  ${src} ${(r.name ?? "").padEnd(12)} ${(r.type ?? "").padEnd(12)} models: ${models}  ${r.description ?? ""}`,
        );
      }
    });

  runtime
    .command("show")
    .description("Show runtime details")
    .argument("<name>")
    .action(async (name) => {
      const r = getApp().runtimes.get(name);
      if (!r) {
        console.log(chalk.red(`Runtime '${name}' not found`));
        return;
      }
      console.log(chalk.bold(`\n${r.name}`) + chalk.dim(` (${r._source})`));
      console.log(`  Type:           ${r.type}`);
      if (r.description) console.log(`  Description:    ${r.description}`);
      if (r.command) console.log(`  Command:        ${r.command.join(" ")}`);
      if (r.task_delivery) console.log(`  Task delivery:  ${r.task_delivery}`);
      if (r.default_model) console.log(`  Default model:  ${r.default_model}`);
      if (r.permission_mode) console.log(`  Permission:     ${r.permission_mode}`);
      if (r.models && r.models.length) {
        console.log(`  Models:`);
        for (const m of r.models) {
          const isDefault = m.id === r.default_model ? chalk.dim(" (default)") : "";
          console.log(`    - ${m.id}: ${m.label}${isDefault}`);
        }
      }
      if (r.env && Object.keys(r.env).length > 0) {
        console.log(`  Env:`);
        for (const [k, v] of Object.entries(r.env)) {
          console.log(`    ${k}=${v}`);
        }
      }
    });
}
