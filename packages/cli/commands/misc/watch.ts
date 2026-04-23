import type { Command } from "commander";
import chalk from "chalk";
import { getInProcessApp } from "../../app-client.js";

/** `ark watch` -- poll GitHub issues with a label and auto-create sessions. */
export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description("Watch GitHub issues with a label and auto-create sessions")
    .option("-l, --label <label>", "GitHub label to watch", "ark")
    .option("-d, --dispatch", "Auto-dispatch created sessions")
    .option("-i, --interval <ms>", "Poll interval in ms", "60000")
    .action(async (opts) => {
      const { startIssuePoller } = await import("../../../core/integrations/issue-poller.js");
      const label = opts.label;
      const intervalMs = parseInt(opts.interval, 10);

      console.log(
        chalk.blue(
          `Watching issues labeled '${label}' (poll every ${intervalMs / 1000}s)${opts.dispatch ? " -- auto-dispatch on" : ""}`,
        ),
      );
      console.log(chalk.dim("Press Ctrl+C to stop.\n"));
      const app = await getInProcessApp();
      const poller = startIssuePoller(app, {
        label,
        intervalMs,
        autoDispatch: opts.dispatch,
      });

      // Keep the process alive until interrupted
      process.on("SIGINT", () => {
        poller.stop();
        console.log(chalk.dim("\nStopped."));
        process.exit(0);
      });

      // Prevent the process from exiting
      await new Promise(() => {});
    });
}
