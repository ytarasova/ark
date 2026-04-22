import { type Command } from "commander";
import chalk from "chalk";
import { runVerification } from "../../../core/services/session-lifecycle.js";
import { getArkClient, getInProcessApp } from "../../app-client.js";
import { formatBytes } from "../../helpers.js";

export function registerLifecycleCommands(session: Command) {
  session
    .command("stop")
    .description("Stop a session")
    .argument("<id>")
    .action(async (id) => {
      const ark = await getArkClient();
      try {
        await ark.sessionStop(id);
        console.log(chalk.yellow("Stopped"));
      } catch (e: any) {
        console.log(chalk.red(e.message));
      }
    });

  session
    .command("resume")
    .description("Resume a stopped/paused session (restores snapshot when available)")
    .argument("<id>")
    .option("--snapshot-id <id>", "Restore from a specific snapshot id (defaults to the session's latest)")
    .action(async (id, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionResume(id, opts.snapshotId);
      if (r.ok) {
        const extra = r.snapshotId ? chalk.dim(`  (snapshot ${r.snapshotId})`) : "";
        console.log(chalk.green(r.message ?? "Resumed") + extra);
      } else {
        console.log(chalk.red(r.message));
      }
    });

  session
    .command("advance")
    .description("Advance to the next flow stage")
    .argument("<id>")
    .option("-f, --force", "Force past gate")
    .action(async (id, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionAdvance(id, opts.force);
      console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
    });

  session
    .command("approve")
    .description("Approve a review gate and advance to the next stage")
    .argument("<id>")
    .action(async (id) => {
      const ark = await getArkClient();
      const r = await ark.gateApprove(id);
      console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
    });

  session
    .command("reject")
    .description("Reject a review gate and dispatch a rework cycle with the given reason")
    .argument("<id>")
    .requiredOption("-r, --reason <text>", "Why the change needs rework (shown to the agent)")
    .action(async (id, opts) => {
      const ark = await getArkClient();
      const reason = String(opts.reason ?? "").trim();
      if (!reason) {
        console.log(chalk.red("--reason is required"));
        process.exitCode = 1;
        return;
      }
      const r = await ark.sessionReject(id, reason);
      console.log(r.ok ? chalk.green(r.message ?? "Rework dispatched") : chalk.red(r.message ?? "Reject failed"));
    });

  session
    .command("complete")
    .description("Mark current stage done and advance")
    .argument("<id>")
    .option("--force", "Skip verification checks")
    .action(async (id, opts) => {
      if (!opts.force) {
        // Run verification first
        const app = await getInProcessApp();
        const result = await runVerification(app, id);
        if (!result.ok) {
          console.log(chalk.red("Verification failed:"));
          console.log(chalk.red(result.message));
          console.log(chalk.dim("Use --force to skip verification"));
          return;
        }
        console.log(chalk.green("Verification passed"));
      }
      const ark = await getArkClient();
      try {
        await ark.sessionComplete(id);
        console.log(chalk.green("Completed"));
      } catch (e: any) {
        console.log(chalk.red(e.message));
      }
    });

  session
    .command("pause")
    .description("Pause a session (persists a snapshot when the compute supports it)")
    .argument("<id>")
    .option("-r, --reason <text>")
    .action(async (id, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionPause(id, opts.reason);
      if (!r.ok) {
        console.log(chalk.red(r.message));
        return;
      }
      if (r.snapshot) {
        console.log(
          chalk.yellow("Paused") + chalk.dim(`  (snapshot ${r.snapshot.id}, ${formatBytes(r.snapshot.sizeBytes)})`),
        );
      } else if (r.notSupported) {
        console.log(chalk.yellow("Paused") + chalk.dim("  (no snapshot: compute does not support snapshots)"));
      } else {
        console.log(chalk.yellow("Paused"));
      }
    });

  session
    .command("interrupt")
    .description("Interrupt a running agent (Ctrl+C) without killing the session")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      const ark = await getArkClient();
      const result = await ark.sessionInterrupt(id);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });

  session
    .command("archive")
    .description("Archive a session for later reference")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      const ark = await getArkClient();
      const result = await ark.sessionArchive(id);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });

  session
    .command("restore")
    .description("Restore an archived session")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      const ark = await getArkClient();
      const result = await ark.sessionRestore(id);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });

  session
    .command("send")
    .description("Send a message to a running Claude session")
    .argument("<id>")
    .argument("<message>")
    .action(async (id, message) => {
      const ark = await getArkClient();
      try {
        await ark.messageSend(id, message);
        console.log(chalk.green("Sent"));
      } catch (e: any) {
        console.log(chalk.red(e.message));
      }
    });

  session
    .command("undelete")
    .description("Restore a recently deleted session (within 90s)")
    .argument("<id>")
    .action(async (id) => {
      const ark = await getArkClient();
      try {
        const result = await ark.sessionUndelete(id);
        console.log(chalk.green(result?.message ?? "Restored"));
      } catch (e: any) {
        console.log(chalk.red(e.message));
      }
    });

  session
    .command("todo")
    .description("Manage session verification todos")
    .argument("<action>", "add|list|done|delete")
    .argument("<session-id>", "Session ID")
    .argument("[text]", "Todo content (for add) or todo ID (for done/delete)")
    .action(async (action, id, text) => {
      const ark = await getArkClient();
      switch (action) {
        case "list": {
          const { todos } = await ark.todoList(id);
          if (todos.length === 0) {
            console.log(chalk.dim("No todos"));
          } else {
            for (const t of todos) {
              const mark = t.done ? chalk.green("[x]") : chalk.red("[ ]");
              console.log(`${mark} #${t.id} ${t.content}`);
            }
          }
          break;
        }
        case "add": {
          if (!text) {
            console.log(chalk.red("Usage: ark session todo add <session-id> <content>"));
            return;
          }
          const { todo } = await ark.todoAdd(id, text);
          console.log(chalk.green(`Added todo #${todo.id}: ${todo.content}`));
          break;
        }
        case "done": {
          if (!text) {
            console.log(chalk.red("Usage: ark session todo done <session-id> <todo-id>"));
            return;
          }
          const { todo } = await ark.todoToggle(parseInt(text, 10));
          if (todo) {
            console.log(chalk.green(`Todo #${todo.id} ${todo.done ? "done" : "undone"}`));
          } else {
            console.log(chalk.red("Todo not found"));
          }
          break;
        }
        case "delete": {
          if (!text) {
            console.log(chalk.red("Usage: ark session todo delete <session-id> <todo-id>"));
            return;
          }
          const { ok } = await ark.todoDelete(parseInt(text, 10));
          console.log(ok ? chalk.green("Deleted") : chalk.red("Not found"));
          break;
        }
        default:
          console.log(chalk.red(`Unknown action: ${action}. Use add|list|done|delete`));
      }
    });

  session
    .command("verify")
    .description("Run verification scripts for a session")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      console.log(chalk.dim("Running verification..."));
      const app = await getInProcessApp();
      const result = await runVerification(app, id);
      if (result.ok) {
        console.log(chalk.green("Verification passed"));
      } else {
        console.log(chalk.red("Verification failed:"));
        if (!result.todosResolved) {
          console.log(chalk.red(`  ${result.pendingTodos.length} unresolved todo(s):`));
          for (const t of result.pendingTodos) {
            console.log(chalk.red(`    - ${t}`));
          }
        }
        for (const r of result.scriptResults) {
          if (!r.passed) {
            console.log(chalk.red(`  Script failed: ${r.script}`));
            if (r.output) console.log(chalk.dim(r.output.slice(0, 500)));
          }
        }
      }
    });

  session
    .command("handoff")
    .description("Hand off to a different agent")
    .argument("<id>")
    .argument("<agent>")
    .option("-i, --instructions <text>")
    .action(async (id, agent, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionHandoff(id, agent, opts.instructions);
      console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
    });

  session
    .command("join")
    .description("Join all forked children")
    .argument("<parent-id>")
    .option("-f, --force")
    .action(async (parentId, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionJoin(parentId, opts.force);
      console.log(r.ok ? chalk.green(r.message) : chalk.yellow(r.message));
    });

  session
    .command("delete")
    .description("Delete sessions")
    .argument("<ids...>")
    .action(async (ids: string[]) => {
      const ark = await getArkClient();
      for (const id of ids) {
        try {
          await ark.sessionDelete(id);
          console.log(chalk.green("Session deleted (undo available for 90s)"));
          console.log(chalk.dim(`  Run 'ark session undelete ${id}' within 90s to undo`));
        } catch (e: any) {
          console.log(chalk.red(`Session ${id}: ${e.message}`));
        }
      }
    });

  session
    .command("group")
    .description("Assign a session to a group")
    .argument("<id>")
    .argument("<group>")
    .action(async (id, group) => {
      const ark = await getArkClient();
      await ark.sessionUpdate(id, { group_name: group });
      console.log(chalk.green(`${id} → group '${group}'`));
    });
}
