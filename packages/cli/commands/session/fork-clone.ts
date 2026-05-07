import { type Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "../../app-client.js";

async function forkCloneHandler(id: string, opts: { task?: string; group?: string }) {
  const ark = await getArkClient();
  try {
    // Server auto-dispatches clones (see handler in packages/conductor/handlers/session.ts).
    const forked = await ark.sessionClone(id, opts.task);
    if (opts.group) await ark.sessionUpdate(forked.id, { group_name: opts.group });
    console.log(chalk.green(`Forked -> ${forked.id}`));
  } catch (e: any) {
    console.log(chalk.red(e.message));
  }
}

export function registerForkCloneCommands(session: Command) {
  session
    .command("fork")
    .description("Fork a session (branches the conversation)")
    .argument("<id>")
    .option("-t, --task <text>", "Task description for forked session")
    .option("-g, --group <name>", "Group for forked session")
    .action(forkCloneHandler);

  session
    .command("clone")
    .description("Alias for fork (branches the conversation)")
    .argument("<id>")
    .option("-t, --task <text>", "Task description for forked session")
    .option("-g, --group <name>", "Group for forked session")
    .action(forkCloneHandler);
}
