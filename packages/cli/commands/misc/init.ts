import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";

/**
 * `ark init` -- first-time repository setup wizard: verify prereqs,
 * claude CLI auth, and drop a starter `.ark.yaml`.
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Ark for this repository")
    .action(async () => {
      const { checkPrereqs, formatPrereqCheck, hasRequiredPrereqs } = await import("../../../core/prereqs.js");

      // 1. Check prerequisites
      console.log(chalk.bold("Checking prerequisites..."));
      const prereqs = checkPrereqs();
      console.log(formatPrereqCheck(prereqs));
      if (!hasRequiredPrereqs(prereqs)) {
        console.log(chalk.red("\nInstall missing tools and try again."));
        process.exit(1);
      }
      console.log(chalk.green("\nAll prerequisites OK.\n"));

      // 2. Check Claude auth
      try {
        execFileSync("claude", ["--version"], { stdio: "pipe", timeout: 5000 });
        console.log(chalk.green("+ Claude CLI authenticated"));
      } catch {
        console.log(chalk.yellow("- Claude CLI not found or not authenticated"));
        console.log("  Run: claude auth login");
      }

      // 3. Create .ark.yaml in current dir if not exists
      const arkYamlPath = ".ark.yaml";
      if (!existsSync(arkYamlPath)) {
        writeFileSync(
          arkYamlPath,
          [
            "# Ark per-repository configuration",
            "# flow: bare          # Default flow for sessions",
            "# agent: implementer  # Default agent",
            "# verify:             # Verification scripts",
            "#   - npm test",
            "# auto_pr: true       # Auto-create PR on completion",
            "",
          ].join("\n"),
        );
        console.log(chalk.green(`\nCreated ${arkYamlPath} (edit to customize)`));
      } else {
        console.log(chalk.dim(`\n${arkYamlPath} already exists`));
      }

      console.log(chalk.bold("\nReady! Try:"));
      console.log(`  ark session start --repo . --summary "My first task" --dispatch`);
    });
}
