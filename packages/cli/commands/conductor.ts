import type { Command } from "commander";
import chalk from "chalk";
import * as core from "../../core/index.js";
import { getInProcessApp } from "../app-client.js";

/**
 * `ark conductor` -- conductor-specific local operations.
 *
 * These reach into the local knowledge graph / bridge config that a daemon
 * would own, so every action boots an in-process AppContext on demand
 * (through `getInProcessApp`). When `--server` is set, the commands fail
 * fast with a friendly message -- conductor operations are not yet
 * exposed over JSON-RPC.
 */
export function registerConductorCommands(program: Command) {
  const conductorCmd = program.command("conductor").description("Conductor operations");

  conductorCmd
    .command("start")
    .description("Start the conductor server")
    .option("-p, --port <port>", "Port", "19100")
    .action(async (opts) => {
      const app = await getInProcessApp();
      const { startConductor } = await import("../../core/conductor/conductor.js");
      startConductor(app, parseInt(opts.port));
      setInterval(() => {}, 60_000);
    });

  conductorCmd
    .command("learnings")
    .description("Show conductor learnings")
    .action(async () => {
      const app = await getInProcessApp();
      const learnings = await app.knowledge.listNodes({ type: "learning" });

      if (learnings.length > 0) {
        const promoted = learnings.filter((l) => ((l.metadata.recurrence as number) ?? 1) >= 3);
        const active = learnings.filter((l) => ((l.metadata.recurrence as number) ?? 1) < 3);

        if (promoted.length > 0) {
          console.log(chalk.bold("\nPolicies (promoted from learnings):\n"));
          for (const p of promoted) {
            console.log(`  ${chalk.green("✓")} ${chalk.bold(p.label)}`);
            if (p.content) console.log(`    ${chalk.dim(p.content.split("\n")[0])}`);
          }
        }

        if (active.length > 0) {
          console.log(chalk.bold("\nActive learnings:\n"));
          for (const l of active) {
            const rec = (l.metadata.recurrence as number) ?? 1;
            const bar = "█".repeat(rec) + "░".repeat(3 - rec);
            console.log(`  ${bar} ${chalk.bold(l.label)} (seen ${rec}x)`);
            if (l.content) console.log(`    ${chalk.dim(l.content.split("\n")[0])}`);
          }
        }
      } else {
        console.log(chalk.dim("No learnings yet. The conductor records patterns during orchestration."));
      }
    });

  conductorCmd
    .command("learn")
    .description("Record a conductor learning")
    .argument("<title>")
    .argument("[description]")
    .action(async (title, description) => {
      const app = await getInProcessApp();
      const existing = await app.knowledge.search(title, { types: ["learning"], limit: 5 });
      const match = existing.find((n) => n.label === title);
      if (match) {
        const recurrence = ((match.metadata.recurrence as number) ?? 1) + 1;
        await app.knowledge.updateNode(match.id, {
          content: description || match.content,
          metadata: { ...match.metadata, recurrence },
        });
        if (recurrence >= 3) {
          console.log(chalk.green(`Promoted to policy: ${title} (recurrence: ${recurrence})`));
        } else {
          console.log(chalk.blue(`Recorded: ${title} (recurrence: ${recurrence}/3)`));
        }
      } else {
        await app.knowledge.addNode({
          type: "learning",
          label: title,
          content: description ?? "",
          metadata: { recurrence: 1 },
        });
        console.log(chalk.blue(`Recorded: ${title} (recurrence: 1/3)`));
      }
    });

  conductorCmd
    .command("bridge")
    .description("Start the messaging bridge (Telegram/Slack)")
    .action(async () => {
      const app = await getInProcessApp();
      const bridge = core.createBridge(app.config.arkDir);
      if (!bridge) {
        console.log(chalk.red("No bridge config found. Create ~/.ark/bridge.json with telegram/slack settings."));
        console.log(chalk.dim("\nExample ~/.ark/bridge.json:"));
        console.log(
          chalk.dim(
            JSON.stringify(
              {
                telegram: { botToken: "123:ABC...", chatId: "12345" },
                slack: { webhookUrl: "https://hooks.slack.com/services/..." },
              },
              null,
              2,
            ),
          ),
        );
        return;
      }

      bridge.onMessage(async (msg) => {
        const text = msg.text.trim().toLowerCase();
        if (text === "/status" || text === "status") {
          await bridge.notifyStatusSummary(app);
        } else if (text === "/sessions" || text === "sessions") {
          const sessions = await app.sessions.list({ limit: 20 });
          const lines = sessions.map((s) => `• ${s.summary ?? s.id} (${s.status})`);
          await bridge.notify(lines.join("\n") || "No sessions");
        } else {
          await bridge.notify(`Unknown command: ${text}`);
        }
      });

      console.log(chalk.green("Bridge started. Ctrl+C to stop."));
      await new Promise(() => {});
    });

  conductorCmd
    .command("notify")
    .description("Send a test notification via bridge")
    .argument("<message>")
    .action(async (message) => {
      const app = await getInProcessApp();
      const bridge = core.createBridge(app.config.arkDir);
      if (!bridge) {
        console.log(chalk.red("No bridge config. Create ~/.ark/bridge.json"));
        return;
      }
      await bridge.notify(message);
      bridge.stop();
      console.log(chalk.green("Notification sent"));
    });
}
