import type { Command } from "commander";
import chalk from "chalk";
import { join, dirname } from "path";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { getInProcessApp } from "../../app-client.js";
import { splitEditorCommand } from "../../helpers.js";

/** `ark config` -- open (or create) the per-user Ark config in `$EDITOR`. */
export function registerConfigCommand(program: Command): void {
  program
    .command("config")
    .description("Open Ark config in your editor")
    .option("--path", "Just print the config path")
    .action(async (opts) => {
      const app = await getInProcessApp();
      const configPath = join(app.config.dirs.ark, "config.yaml");

      // Create default config if missing
      if (!existsSync(configPath)) {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(
          configPath,
          [
            "# Ark configuration",
            "# See: https://github.com/your-org/ark#configuration",
            "",
            "# hotkeys:",
            "#   delete: x",
            "#   fork: f",
            "",
            "# budgets:",
            "#   dailyLimit: 50",
            "#   weeklyLimit: 200",
            "",
          ].join("\n"),
        );
      }

      if (opts.path) {
        console.log(configPath);
        return;
      }

      const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
      console.log(chalk.dim(`Opening ${configPath} in ${editor}...`));
      const { command: editorCmd, args: editorArgs } = splitEditorCommand(editor);
      execFileSync(editorCmd, [...editorArgs, configPath], { stdio: "inherit" });
    });
}
