import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "./_shared.js";

export function registerScheduleCommands(program: Command) {
  const schedule = program.command("schedule").description("Manage scheduled recurring sessions");

  schedule
    .command("add")
    .description("Create a recurring scheduled session")
    .requiredOption("--cron <expression>", 'Cron expression (e.g., "0 2 * * *")')
    .option("-f, --flow <name>", "Flow name", "bare")
    .option("-r, --repo <path>", "Repository path")
    .option("-s, --summary <text>", "Session summary")
    .option("-c, --compute <name>", "Compute name")
    .option("-g, --group <name>", "Group name")
    .action(async (opts) => {
      const ark = await getArkClient();
      const sched = await ark.scheduleCreate({
        cron: opts.cron,
        flow: opts.flow,
        repo: opts.repo,
        summary: opts.summary,
        compute_name: opts.compute,
        group_name: opts.group,
      });
      console.log(chalk.green(`Schedule ${sched.id} created`));
      console.log(`  Cron:    ${sched.cron}`);
      console.log(`  Flow:    ${sched.flow}`);
      if (sched.repo) console.log(`  Repo:    ${sched.repo}`);
      if (sched.summary) console.log(`  Summary: ${sched.summary}`);
    });

  schedule
    .command("list")
    .description("List all schedules")
    .action(async () => {
      const ark = await getArkClient();
      const schedules = await ark.scheduleList();
      if (schedules.length === 0) {
        console.log(chalk.yellow("No schedules."));
        return;
      }
      for (const s of schedules) {
        const status = s.enabled ? chalk.green("●") : chalk.dim("○");
        const lastRun = s.last_run ? s.last_run.slice(0, 19) : "never";
        console.log(
          `  ${status} ${chalk.dim(s.id)}  ${s.cron.padEnd(15)}  ${s.flow.padEnd(10)}  last:${lastRun}  ${s.summary || ""}`,
        );
      }
    });

  schedule
    .command("delete")
    .description("Delete a schedule")
    .argument("<id>", "Schedule ID")
    .action(async (id) => {
      const ark = await getArkClient();
      const ok = await ark.scheduleDelete(id);
      console.log(ok ? chalk.green(`Deleted ${id}`) : chalk.red(`Schedule ${id} not found`));
    });

  schedule
    .command("enable")
    .description("Enable a schedule")
    .argument("<id>", "Schedule ID")
    .action(async (id) => {
      const ark = await getArkClient();
      await ark.scheduleEnable(id);
      console.log(chalk.green(`Enabled ${id}`));
    });

  schedule
    .command("disable")
    .description("Disable a schedule")
    .argument("<id>", "Schedule ID")
    .action(async (id) => {
      const ark = await getArkClient();
      await ark.scheduleDisable(id);
      console.log(chalk.yellow(`Disabled ${id}`));
    });
}
