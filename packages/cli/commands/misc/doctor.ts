import type { Command } from "commander";
import chalk from "chalk";

/** `ark doctor` -- check that required system prerequisites are installed. */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check system prerequisites")
    .action(async () => {
      const { checkPrereqs, formatPrereqCheck, hasRequiredPrereqs } = await import("../../../core/prereqs.js");
      const results = checkPrereqs();
      console.log("Ark Prerequisites:");
      console.log(formatPrereqCheck(results));
      if (hasRequiredPrereqs(results)) {
        console.log(chalk.green("\nAll required tools available."));
      } else {
        console.log(chalk.red("\nSome required tools are missing. Install them and try again."));
        process.exit(1);
      }
    });
}
