import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "./_shared.js";

export function registerProfileCommands(program: Command) {
  const profile = program.command("profile").description("Manage profiles");

  profile.command("list")
    .description("List profiles")
    .action(async () => {
      const ark = await getArkClient();
      const { profiles, active } = await ark.profileList();
      for (const p of profiles) {
        const marker = p.name === active ? chalk.green(" (active)") : "";
        console.log(`  ${p.name}${marker}${p.description ? chalk.dim(` -- ${p.description}`) : ""}`);
      }
    });

  profile.command("create")
    .description("Create a profile")
    .argument("<name>")
    .argument("[description]")
    .action(async (name: string, desc: string | undefined) => {
      const ark = await getArkClient();
      try {
        await ark.profileCreate(name, desc);
        console.log(chalk.green(`Created profile: ${name}`));
      } catch (e: any) { console.log(chalk.red(e.message)); }
    });

  profile.command("delete")
    .description("Delete a profile")
    .argument("<name>")
    .action(async (name: string) => {
      const ark = await getArkClient();
      try {
        await ark.profileDelete(name);
        console.log(chalk.green(`Deleted profile: ${name}`));
      } catch (e: any) { console.log(chalk.red(e.message)); }
    });
}
