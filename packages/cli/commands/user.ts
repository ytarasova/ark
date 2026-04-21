/**
 * CLI commands for user management:
 *   ark user list
 *   ark user get <email>
 *   ark user create --email a@b --name "..."
 *   ark user delete <idOrEmail>
 *
 * Users are durable identities keyed by email. Authentication (password,
 * OIDC, JWT) is out of scope for this CLI surface.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { UserManager } from "../../core/auth/index.js";
import type { AppContext } from "../../core/app.js";

export function registerUserCommands(program: Command, app: AppContext) {
  const user = program.command("user").description("Manage user identities");

  user
    .command("list")
    .description("List users")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const rows = await new UserManager(app.db).list();
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
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  user
    .command("get")
    .description("Show a user by id or email")
    .argument("<idOrEmail>", "User id or email")
    .option("--json", "Output raw JSON")
    .action(async (idOrEmail, opts) => {
      try {
        const u = await new UserManager(app.db).get(idOrEmail);
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
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  user
    .command("create")
    .description("Create a user")
    .requiredOption("--email <email>", "User email (unique)")
    .option("--name <name>", "Display name")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const u = await new UserManager(app.db).create({ email: opts.email, name: opts.name ?? null });
        if (opts.json) console.log(JSON.stringify(u, null, 2));
        else console.log(chalk.green(`User created: ${u.id} (${u.email})`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  user
    .command("delete")
    .description("Delete a user (cascades memberships)")
    .argument("<idOrEmail>", "User id or email")
    .action(async (idOrEmail) => {
      try {
        const um = new UserManager(app.db);
        const u = await um.get(idOrEmail);
        if (!u) {
          console.log(chalk.red(`User '${idOrEmail}' not found`));
          return;
        }
        const ok = await um.delete(u.id);
        console.log(ok ? chalk.green(`User deleted: ${u.id}`) : chalk.red("Delete failed"));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });
}
