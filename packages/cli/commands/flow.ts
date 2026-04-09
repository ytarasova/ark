import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "./_shared.js";

export function registerFlowCommands(program: Command) {
  const pipe = program.command("flow").description("Manage flows");

  pipe.command("list").description("List flows").action(async () => {
    const ark = await getArkClient();
    const flows = await ark.flowList();
    for (const p of flows) {
      console.log(`  ${p.name.padEnd(16)} ${p.stages.join(" > ")}  ${chalk.dim(p.description.slice(0, 40))}`);
    }
  });

  pipe.command("show").description("Show flow").argument("<name>").action(async (name) => {
    const ark = await getArkClient();
    try {
      const p = await ark.flowRead(name);
      console.log(chalk.bold(`\n${p.name}`));
      if (p.description) console.log(chalk.dim(`  ${p.description}`));
      for (const [i, s] of p.stages.entries()) {
        const type = s.type ?? (s.action ? "action" : "agent");
        const detail = s.agent ?? s.action ?? "";
        console.log(`  ${i + 1}. ${s.name.padEnd(14)} [${type}:${detail}] gate=${s.gate}${s.optional ? " (optional)" : ""}`);
      }
    } catch {
      console.log(chalk.red("Not found"));
    }
  });
}
