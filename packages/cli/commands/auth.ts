import type { Command } from "commander";
import chalk from "chalk";
import { getApp } from "../../core/app.js";

export function registerAuthCommands(program: Command) {
  const authCmd = program.command("auth").description("Manage API keys and auth");

  authCmd.command("create-key")
    .description("Create a new API key")
    .option("--name <name>", "Human-readable label for the key", "default")
    .option("--role <role>", "Role: admin, member, or viewer", "member")
    .option("--tenant <tenantId>", "Tenant ID", "default")
    .option("--expires <date>", "Expiration date (ISO 8601)")
    .action((opts: any) => {
      const app = getApp();
      const role = opts.role as "admin" | "member" | "viewer";
      if (!["admin", "member", "viewer"].includes(role)) {
        console.error(chalk.red(`Invalid role: ${role}. Must be admin, member, or viewer.`));
        process.exit(1);
      }
      const result = app.apiKeys.create(opts.tenant, opts.name, role, opts.expires);
      console.log(chalk.green("API key created successfully."));
      console.log();
      console.log(`  ${chalk.bold("ID:")}    ${result.id}`);
      console.log(`  ${chalk.bold("Key:")}   ${result.key}`);
      console.log(`  ${chalk.bold("Role:")}  ${role}`);
      console.log(`  ${chalk.bold("Tenant:")} ${opts.tenant}`);
      console.log();
      console.log(chalk.yellow("Save the key now -- it cannot be retrieved later."));
    });

  authCmd.command("list-keys")
    .description("List API keys")
    .option("--tenant <tenantId>", "Tenant ID", "default")
    .action((opts: any) => {
      const app = getApp();
      const keys = app.apiKeys.list(opts.tenant);
      if (!keys.length) {
        console.log(chalk.dim("No API keys found."));
        return;
      }
      console.log(chalk.bold(`API keys for tenant: ${opts.tenant}`));
      console.log();
      for (const k of keys) {
        const expires = k.expiresAt ? ` expires ${k.expiresAt}` : "";
        const lastUsed = k.lastUsedAt ? ` last used ${k.lastUsedAt}` : " never used";
        console.log(`  ${k.id.padEnd(14)} ${k.name.padEnd(20)} ${k.role.padEnd(8)} created ${k.createdAt.slice(0, 10)}${expires}${lastUsed}`);
      }
    });

  authCmd.command("revoke-key")
    .description("Revoke an API key")
    .argument("<id>", "API key ID (e.g. ak-abcd1234)")
    .action((id: string) => {
      const app = getApp();
      const ok = app.apiKeys.revoke(id);
      if (ok) {
        console.log(chalk.green(`Revoked API key: ${id}`));
      } else {
        console.error(chalk.red(`API key not found: ${id}`));
        process.exit(1);
      }
    });

  authCmd.command("rotate-key")
    .description("Rotate an API key (revoke old, create new with same metadata)")
    .argument("<id>", "API key ID to rotate")
    .action((id: string) => {
      const app = getApp();
      const result = app.apiKeys.rotate(id);
      if (!result) {
        console.error(chalk.red(`API key not found: ${id}`));
        process.exit(1);
      }
      console.log(chalk.green("API key rotated successfully."));
      console.log();
      console.log(`  ${chalk.bold("New key:")} ${result.key}`);
      console.log();
      console.log(chalk.yellow("Save the key now -- it cannot be retrieved later."));
    });
}
