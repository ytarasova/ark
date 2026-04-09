import type { Command } from "commander";
import chalk from "chalk";
import * as core from "../../core/index.js";

export function registerConductorCommands(program: Command) {
  const conductorCmd = program.command("conductor").description("Conductor operations");

  conductorCmd.command("start")
    .description("Start the conductor server")
    .option("-p, --port <port>", "Port", "19100")
    .action(async (opts) => {
      const { startConductor } = await import("../../core/conductor.js");
      startConductor(parseInt(opts.port));
      // Keep alive
      setInterval(() => {}, 60_000);
    });

  conductorCmd.command("learnings")
    .description("Show conductor learnings and policies")
    .action(async () => {
      const core = await import("../../core/index.js");
      const dir = core.conductorLearningsDir(core.ARK_DIR());
      const learnings = core.getLearnings(dir);
      const policies = core.getPolicies(dir);

      if (policies.length > 0) {
        console.log(chalk.bold("\nPolicies (promoted from learnings):\n"));
        for (const p of policies) {
          console.log(`  ${chalk.green("\u2713")} ${chalk.bold(p.title)}`);
          if (p.description) console.log(`    ${chalk.dim(p.description.split("\n")[0])}`);
        }
      }

      if (learnings.length > 0) {
        console.log(chalk.bold("\nActive learnings:\n"));
        for (const l of learnings) {
          const bar = "\u2588".repeat(l.recurrence) + "\u2591".repeat(3 - l.recurrence);
          console.log(`  ${bar} ${chalk.bold(l.title)} (seen ${l.recurrence}x)`);
          if (l.description) console.log(`    ${chalk.dim(l.description.split("\n")[0])}`);
        }
      }

      if (learnings.length === 0 && policies.length === 0) {
        console.log(chalk.dim("No learnings yet. The conductor records patterns during orchestration."));
      }
    });

  conductorCmd.command("learn")
    .description("Record a conductor learning")
    .argument("<title>")
    .argument("[description]")
    .action(async (title, description) => {
      const core = await import("../../core/index.js");
      const dir = core.conductorLearningsDir(core.ARK_DIR());
      const result = core.recordLearning(dir, title, description ?? "");
      if (result.promoted) {
        console.log(chalk.green(`Promoted to policy: ${title} (recurrence: ${result.learning.recurrence})`));
      } else {
        console.log(chalk.blue(`Recorded: ${title} (recurrence: ${result.learning.recurrence}/3)`));
      }
    });

  conductorCmd.command("bridge")
    .description("Start the messaging bridge (Telegram/Slack)")
    .action(async () => {
      const bridge = core.createBridge();
      if (!bridge) {
        console.log(chalk.red("No bridge config found. Create ~/.ark/bridge.json with telegram/slack settings."));
        console.log(chalk.dim("\nExample ~/.ark/bridge.json:"));
        console.log(chalk.dim(JSON.stringify({
          telegram: { botToken: "123:ABC...", chatId: "12345" },
          slack: { webhookUrl: "https://hooks.slack.com/services/..." },
        }, null, 2)));
        return;
      }

      // Handle common commands
      bridge.onMessage(async (msg) => {
        const text = msg.text.trim().toLowerCase();
        if (text === "/status" || text === "status") {
          await bridge.notifyStatusSummary();
        } else if (text === "/sessions" || text === "sessions") {
          const sessions = core.getApp().sessions.list({ limit: 20 });
          const lines = sessions.map(s => `\u2022 ${s.summary ?? s.id} (${s.status})`);
          await bridge.notify(lines.join("\n") || "No sessions");
        } else {
          await bridge.notify(`Unknown command: ${text}`);
        }
      });

      console.log(chalk.green("Bridge started. Ctrl+C to stop."));

      // Keep alive
      await new Promise(() => {});
    });

  conductorCmd.command("notify")
    .description("Send a test notification via bridge")
    .argument("<message>")
    .action(async (message) => {
      const bridge = core.createBridge();
      if (!bridge) {
        console.log(chalk.red("No bridge config. Create ~/.ark/bridge.json"));
        return;
      }
      await bridge.notify(message);
      bridge.stop();
      console.log(chalk.green("Notification sent"));
    });
}
