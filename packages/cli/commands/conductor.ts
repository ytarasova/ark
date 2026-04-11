import type { Command } from "commander";
import chalk from "chalk";
import * as core from "../../core/index.js";
import { getApp } from "../../core/app.js";

export function registerConductorCommands(program: Command) {
  const conductorCmd = program.command("conductor").description("Conductor operations");

  conductorCmd.command("start")
    .description("Start the conductor server")
    .option("-p, --port <port>", "Port", "19100")
    .action(async (opts) => {
      const { startConductor } = await import("../../core/conductor/conductor.js");
      const { getApp } = await import("../../core/app.js");
      startConductor(getApp(), parseInt(opts.port));
      // Keep alive
      setInterval(() => {}, 60_000);
    });

  conductorCmd.command("learnings")
    .description("Show conductor learnings")
    .action(async () => {
      const app = getApp();
      const learnings = app.knowledge.listNodes({ type: "learning" });

      if (learnings.length > 0) {
        // Split into "promoted" (recurrence >= 3) and active
        const promoted = learnings.filter(l => ((l.metadata.recurrence as number) ?? 1) >= 3);
        const active = learnings.filter(l => ((l.metadata.recurrence as number) ?? 1) < 3);

        if (promoted.length > 0) {
          console.log(chalk.bold("\nPolicies (promoted from learnings):\n"));
          for (const p of promoted) {
            console.log(`  ${chalk.green("\u2713")} ${chalk.bold(p.label)}`);
            if (p.content) console.log(`    ${chalk.dim(p.content.split("\n")[0])}`);
          }
        }

        if (active.length > 0) {
          console.log(chalk.bold("\nActive learnings:\n"));
          for (const l of active) {
            const rec = (l.metadata.recurrence as number) ?? 1;
            const bar = "\u2588".repeat(rec) + "\u2591".repeat(3 - rec);
            console.log(`  ${bar} ${chalk.bold(l.label)} (seen ${rec}x)`);
            if (l.content) console.log(`    ${chalk.dim(l.content.split("\n")[0])}`);
          }
        }
      } else {
        console.log(chalk.dim("No learnings yet. The conductor records patterns during orchestration."));
      }
    });

  conductorCmd.command("learn")
    .description("Record a conductor learning")
    .argument("<title>")
    .argument("[description]")
    .action(async (title, description) => {
      const app = getApp();
      // Check for existing learning with same label and increment recurrence
      const existing = app.knowledge.search(title, { types: ["learning"], limit: 5 });
      const match = existing.find(n => n.label === title);
      if (match) {
        const recurrence = ((match.metadata.recurrence as number) ?? 1) + 1;
        app.knowledge.updateNode(match.id, {
          content: description || match.content,
          metadata: { ...match.metadata, recurrence },
        });
        if (recurrence >= 3) {
          console.log(chalk.green(`Promoted to policy: ${title} (recurrence: ${recurrence})`));
        } else {
          console.log(chalk.blue(`Recorded: ${title} (recurrence: ${recurrence}/3)`));
        }
      } else {
        app.knowledge.addNode({
          type: "learning",
          label: title,
          content: description ?? "",
          metadata: { recurrence: 1 },
        });
        console.log(chalk.blue(`Recorded: ${title} (recurrence: 1/3)`));
      }
    });

  conductorCmd.command("bridge")
    .description("Start the messaging bridge (Telegram/Slack)")
    .action(async () => {
      const bridge = core.createBridge(getApp().config.arkDir);
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
          await bridge.notifyStatusSummary(getApp());
        } else if (text === "/sessions" || text === "sessions") {
          const sessions = getApp().sessions.list({ limit: 20 });
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
      const bridge = core.createBridge(getApp().config.arkDir);
      if (!bridge) {
        console.log(chalk.red("No bridge config. Create ~/.ark/bridge.json"));
        return;
      }
      await bridge.notify(message);
      bridge.stop();
      console.log(chalk.green("Notification sent"));
    });
}
