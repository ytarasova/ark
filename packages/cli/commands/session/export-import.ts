import { type Command } from "commander";
import chalk from "chalk";
import * as core from "../../../core/index.js";
import { getArkClient, getInProcessApp } from "../../app-client.js";

export function registerExportImportCommands(session: Command) {
  session
    .command("export")
    .description("Export session to file")
    .argument("<id>")
    .argument("[file]")
    .action(async (id, file) => {
      const outPath = file ?? `session-${id}.json`;
      const ark = await getArkClient();
      try {
        const result = await ark.sessionExport(id, outPath);
        if (result.ok) {
          console.log(chalk.green(`Exported to ${result.filePath ?? outPath}`));
        } else {
          console.log(chalk.red("Session not found"));
        }
      } catch (e: any) {
        console.log(chalk.red(e.message ?? "Export failed"));
      }
    });

  session
    .command("import")
    .description("Import session from file")
    .argument("<file>")
    .action(async (file) => {
      // Import remains local-only: it reads from the caller's filesystem and
      // writes rows into the DB. There is no import RPC yet; fall through to
      // the in-process app so the UX still works on a clean checkout.
      const app = await getInProcessApp();
      const result = await core.importSessionFromFile(app, file);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });
}
