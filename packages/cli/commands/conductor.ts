import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "../app-client.js";

/**
 * `ark conductor` -- thin client over the daemon's conductor/* RPC surface.
 *
 * Every subcommand rides `getArkClient()` so `--server <url>` works the same
 * as talking to a local auto-spawned daemon. The daemon owns the conductor
 * loop, the knowledge graph, and the bridge config.
 *
 * Local-by-nature carve-outs (documented + retained as CLI-side behavior):
 *   - `conductor start` is gone: starting the conductor is a daemon-boot
 *     concern, not a CLI command. Use `ark server daemon start` to bring
 *     one up. Use `conductor status` to check liveness.
 *   - The `bridge` subcommand previously blocked on a never-resolving
 *     promise to keep the inbound poller alive. It now calls the RPC
 *     (which arms the poller on the daemon) and returns immediately; the
 *     poller outlives this CLI invocation on the daemon side.
 */
export function registerConductorCommands(program: Command) {
  const conductorCmd = program.command("conductor").description("Conductor operations");

  conductorCmd
    .command("status")
    .description("Show whether a conductor is running on the daemon")
    .action(async () => {
      const ark = await getArkClient();
      const { running, port, pid } = await ark.conductorStatus();
      if (running) {
        console.log(chalk.green(`Conductor is running on port ${port}${pid ? ` (pid ${pid})` : ""}`));
      } else {
        console.log(chalk.yellow(`No conductor running. Expected port: ${port}`));
        console.log(chalk.dim("Start one with: ark server daemon start"));
      }
    });

  conductorCmd
    .command("learnings")
    .description("Show conductor learnings")
    .action(async () => {
      const ark = await getArkClient();
      const { learnings } = await ark.conductorLearnings();

      if (learnings.length === 0) {
        console.log(chalk.dim("No learnings yet. The conductor records patterns during orchestration."));
        return;
      }

      const promoted = learnings.filter((l) => l.promoted);
      const active = learnings.filter((l) => !l.promoted);

      if (promoted.length > 0) {
        console.log(chalk.bold("\nPolicies (promoted from learnings):\n"));
        for (const p of promoted) {
          console.log(`  ${chalk.green("✓")} ${chalk.bold(p.title)}`);
          if (p.description) console.log(`    ${chalk.dim(p.description.split("\n")[0])}`);
        }
      }

      if (active.length > 0) {
        console.log(chalk.bold("\nActive learnings:\n"));
        for (const l of active) {
          const rec = Math.max(1, Math.min(3, l.recurrence));
          const bar = "█".repeat(rec) + "░".repeat(3 - rec);
          console.log(`  ${bar} ${chalk.bold(l.title)} (seen ${l.recurrence}x)`);
          if (l.description) console.log(`    ${chalk.dim(l.description.split("\n")[0])}`);
        }
      }
    });

  conductorCmd
    .command("learn")
    .description("Record a conductor learning")
    .argument("<title>")
    .argument("[description]")
    .action(async (title: string, description?: string) => {
      const ark = await getArkClient();
      const { learning } = await ark.conductorLearn({ title, description });
      if (learning.promoted) {
        console.log(chalk.green(`Promoted to policy: ${title} (recurrence: ${learning.recurrence})`));
      } else {
        console.log(chalk.blue(`Recorded: ${title} (recurrence: ${learning.recurrence}/3)`));
      }
    });

  conductorCmd
    .command("bridge")
    .description("Start the messaging bridge (Slack/email) on the daemon")
    .action(async () => {
      const ark = await getArkClient();
      const result = await ark.conductorBridge();
      if (!result.ok) {
        console.log(chalk.red(result.message ?? "Bridge failed to start"));
        console.log(chalk.dim("\nExample ~/.ark/bridge.json:"));
        console.log(
          chalk.dim(
            JSON.stringify(
              {
                slack: { webhookUrl: "https://hooks.slack.com/services/..." },
                email: {
                  host: "smtp.gmail.com",
                  port: 587,
                  secure: false,
                  auth: { user: "ark@example.com", pass: "app-password" },
                  from: "Ark <ark@example.com>",
                  to: "ops@example.com",
                },
              },
              null,
              2,
            ),
          ),
        );
        return;
      }
      console.log(chalk.green("Bridge started on the daemon. It will continue to run in the background."));
    });

  conductorCmd
    .command("notify")
    .description("Send a test notification via bridge")
    .argument("<message>")
    .action(async (message: string) => {
      const ark = await getArkClient();
      const result = await ark.conductorNotify(message);
      if (!result.ok) {
        console.log(chalk.red(result.message ?? "No bridge config. Create ~/.ark/bridge.json"));
        return;
      }
      console.log(chalk.green("Notification sent"));
    });
}
