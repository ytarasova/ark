import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "../app-client.js";
import { runAction } from "./_shared.js";

/**
 * Auth commands. API-key CRUD dispatches to `admin/apikey/*` over RPC so
 * admin-gate enforcement is consistent with the rest of the admin surface.
 *
 * The legacy `ark auth setup` (local + remote OAuth token capture) was
 * removed: it conflated two unrelated concerns -- agent-runtime credentials
 * and ark-API access -- and bypassed the secret store. Agent runtimes now
 * declare what they need via `secrets: [...]` in their YAML (see
 * runtimes/claude.yaml, runtimes/agent-sdk.yaml); operators store the
 * value with `ark secret set <NAME> <VALUE>` and dispatch resolves it via
 * `app.secrets.resolveMany(tenantId, names)`. Subscription-blob auth
 * (claude-max) stays on `ark tenant auth set --subscription-blob`.
 */
export function registerAuthCommands(program: Command) {
  const authCmd = program.command("auth").description("Manage authentication and API keys");

  authCmd
    .command("create-key")
    .description("Create a new API key")
    .option("--name <name>", "Human-readable label for the key", "default")
    .option("--role <role>", "Role: admin, member, or viewer", "member")
    .option("--tenant <tenantId>", "Tenant ID", "default")
    .option("--expires <date>", "Expiration date (ISO 8601)")
    .action(async (opts: any) => {
      const role = opts.role as "admin" | "member" | "viewer";
      if (!["admin", "member", "viewer"].includes(role)) {
        console.error(chalk.red(`Invalid role: ${role}. Must be admin, member, or viewer.`));
        process.exit(1);
      }
      await runAction("auth create-key", async () => {
        const ark = await getArkClient();
        const result = await ark.apiKeyCreate({
          tenant_id: opts.tenant,
          name: opts.name,
          role,
          ...(opts.expires ? { expires_at: opts.expires } : {}),
        });
        console.log(chalk.green("API key created successfully."));
        console.log();
        console.log(`  ${chalk.bold("ID:")}    ${result.id}`);
        console.log(`  ${chalk.bold("Key:")}   ${result.key}`);
        console.log(`  ${chalk.bold("Role:")}  ${result.role}`);
        console.log(`  ${chalk.bold("Tenant:")} ${result.tenant_id}`);
        console.log();
        console.log(chalk.yellow("Save the key now -- it cannot be retrieved later."));
      });
    });

  authCmd
    .command("list-keys")
    .description("List API keys")
    .option("--tenant <tenantId>", "Tenant ID", "default")
    .action(async (opts: any) => {
      await runAction("auth list-keys", async () => {
        const ark = await getArkClient();
        const keys = await ark.apiKeyList(opts.tenant);
        if (!keys.length) {
          console.log(chalk.dim("No API keys found."));
          return;
        }
        console.log(chalk.bold(`API keys for tenant: ${opts.tenant}`));
        console.log();
        for (const k of keys) {
          const expires = k.expires_at ? ` expires ${k.expires_at}` : "";
          const lastUsed = k.last_used_at ? ` last used ${k.last_used_at}` : " never used";
          console.log(
            `  ${k.id.padEnd(14)} ${k.name.padEnd(20)} ${k.role.padEnd(8)} created ${k.created_at.slice(0, 10)}${expires}${lastUsed}`,
          );
        }
      });
    });

  authCmd
    .command("revoke-key")
    .description("Revoke an API key")
    .argument("<id>", "API key ID (e.g. ak-abcd1234)")
    .option("--tenant <tenantId>", "Scope to this tenant (safer in multi-tenant setups)")
    .action(async (id: string, opts: any) => {
      await runAction("auth revoke-key", async () => {
        const ark = await getArkClient();
        const ok = await ark.apiKeyRevoke(id, opts.tenant);
        if (ok) {
          console.log(chalk.green(`Revoked API key: ${id}`));
        } else {
          console.error(chalk.red(`API key not found: ${id}`));
          process.exitCode = 1;
        }
      });
    });

  authCmd
    .command("rotate-key")
    .description("Rotate an API key (revoke old, create new with same metadata)")
    .argument("<id>", "API key ID to rotate")
    .option("--tenant <tenantId>", "Scope to this tenant (safer in multi-tenant setups)")
    .action(async (id: string, opts: any) => {
      await runAction("auth rotate-key", async () => {
        const ark = await getArkClient();
        const result = await ark.apiKeyRotate(id, opts.tenant);
        console.log(chalk.green("API key rotated successfully."));
        console.log();
        console.log(`  ${chalk.bold("New key:")} ${result.key}`);
        console.log();
        console.log(chalk.yellow("Save the key now -- it cannot be retrieved later."));
      });
    });
}
