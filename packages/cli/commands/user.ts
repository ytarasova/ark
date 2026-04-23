/**
 * CLI commands for user management:
 *   ark user list
 *   ark user get <email>
 *   ark user create --email a@b --name "..."
 *   ark user delete <idOrEmail>
 *
 * Users are durable identities keyed by email. Every subcommand dispatches
 * via ArkClient against admin/user/*.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "../app-client.js";
import { runAction } from "./_shared.js";

export function registerUserCommands(program: Command) {
  const user = program.command("user").description("Manage user identities");

  user
    .command("list")
    .description("List users")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      await runAction("user list", async () => {
        const ark = await getArkClient();
        const rows = await ark.adminUserList();
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (!rows.length) {
          console.log(chalk.dim("No users yet."));
          return;
        }
        console.log(`  ${"ID".padEnd(20)} ${"EMAIL".padEnd(32)} NAME`);
        for (const u of rows) {
          console.log(`  ${u.id.padEnd(20)} ${u.email.padEnd(32)} ${u.name ?? ""}`);
        }
      });
    });

  user
    .command("get")
    .description("Show a user by id or email")
    .argument("<idOrEmail>", "User id or email")
    .option("--json", "Output raw JSON")
    .action(async (idOrEmail, opts) => {
      await runAction("user get", async () => {
        const ark = await getArkClient();
        const u = await ark.adminUserGet(idOrEmail);
        if (!u) {
          console.log(chalk.red(`User '${idOrEmail}' not found`));
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(u, null, 2));
          return;
        }
        console.log(chalk.bold(u.email));
        console.log(`  id:         ${u.id}`);
        console.log(`  name:       ${u.name ?? ""}`);
        console.log(`  created:    ${u.created_at}`);
      });
    });

  user
    .command("create")
    .description("Create a user")
    .requiredOption("--email <email>", "User email (unique)")
    .option("--name <name>", "Display name")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      await runAction("user create", async () => {
        const ark = await getArkClient();
        const u = await ark.adminUserCreate({ email: opts.email, name: opts.name ?? null });
        if (opts.json) console.log(JSON.stringify(u, null, 2));
        else console.log(chalk.green(`User created: ${u.id} (${u.email})`));
      });
    });

  user
    .command("delete")
    .description("Delete a user (cascades memberships)")
    .argument("<idOrEmail>", "User id or email")
    .action(async (idOrEmail) => {
      await runAction("user delete", async () => {
        const ark = await getArkClient();
        const u = await ark.adminUserGet(idOrEmail);
        if (!u) {
          console.log(chalk.red(`User '${idOrEmail}' not found`));
          return;
        }
        const ok = await ark.adminUserDelete(u.id);
        console.log(ok ? chalk.green(`User deleted: ${u.id}`) : chalk.red("Delete failed"));
      });
    });
}
