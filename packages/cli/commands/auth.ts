import type { Command } from "commander";
import chalk from "chalk";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getArkClient } from "../app-client.js";

/**
 * Auth commands. API-key CRUD dispatches to `admin/apikey/*` over RPC so
 * admin-gate enforcement is consistent with the rest of the admin surface.
 * `ark auth setup` remains a local-only flow -- it writes an OAuth token
 * into ~/.ark regardless of mode.
 */
export function registerAuthCommands(program: Command) {
  const authCmd = program.command("auth").description("Manage authentication and API keys");

  // Claude CLI auth setup (moved from misc.ts)
  authCmd
    .command("setup")
    .description("Set up Claude authentication (local or remote)")
    .option("--host <name>", "Run setup-token on a specific remote compute")
    .action(async (opts) => {
      if (opts.host) {
        const ark = await getArkClient();
        let compute: any;
        try {
          compute = await ark.computeRead(opts.host);
        } catch {
          console.error(`Compute '${opts.host}' not found`);
          process.exit(1);
        }
        const cfg = compute.config as { ip?: string };
        if (!cfg.ip) {
          console.error(`No IP for '${opts.host}'`);
          process.exit(1);
        }
        const key = `${process.env.HOME}/.ssh/ark-${compute.name}`;
        console.log(`Running setup-token on ${compute.name} (${cfg.ip})...`);
        execFileSync(
          "ssh",
          ["-i", key, "-o", "StrictHostKeyChecking=no", "-t", `ubuntu@${cfg.ip}`, "~/.local/bin/claude setup-token"],
          { stdio: "inherit" },
        );
      } else {
        const { spawn } = await import("child_process");
        console.log("Setting up Claude authentication...\n");
        const exitCode = await new Promise<number>((resolve) => {
          const child = spawn("claude", ["setup-token"], { stdio: "inherit" });
          process.on("SIGINT", () => child.kill("SIGINT"));
          child.on("close", (code) => resolve(code ?? 1));
        });
        if (exitCode !== 0) process.exit(exitCode);

        console.log("\nPaste the full OAuth token (sk-ant-oat01-...) and press Enter:");
        process.stdout.write("> ");
        const readline = await import("readline");
        const rl = readline.createInterface({ input: process.stdin });
        let tokenBuf = "";
        const token = await new Promise<string>((resolve) => {
          rl.on("close", () => resolve(tokenBuf.trim()));
          rl.on("line", (line) => {
            tokenBuf += line.trim();
            if (tokenBuf.startsWith("sk-ant-oat") && tokenBuf.length >= 100) rl.close();
          });
        });

        if (token.startsWith("sk-ant-oat")) {
          const arkDir = join(process.env.HOME!, ".ark");
          mkdirSync(arkDir, { recursive: true });
          writeFileSync(join(arkDir, "claude-oauth-token"), token, { mode: 0o600 });
          console.log(`\n+ Token saved to ~/.ark/claude-oauth-token`);
        } else if (token) {
          console.log("\nToken doesn't look right (should start with sk-ant-oat). Try again.");
        }
      }
    });

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
      try {
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
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exit(1);
      }
    });

  authCmd
    .command("list-keys")
    .description("List API keys")
    .option("--tenant <tenantId>", "Tenant ID", "default")
    .action(async (opts: any) => {
      try {
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
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exit(1);
      }
    });

  authCmd
    .command("revoke-key")
    .description("Revoke an API key")
    .argument("<id>", "API key ID (e.g. ak-abcd1234)")
    .option("--tenant <tenantId>", "Scope to this tenant (safer in multi-tenant setups)")
    .action(async (id: string, opts: any) => {
      try {
        const ark = await getArkClient();
        const ok = await ark.apiKeyRevoke(id, opts.tenant);
        if (ok) {
          console.log(chalk.green(`Revoked API key: ${id}`));
        } else {
          console.error(chalk.red(`API key not found: ${id}`));
          process.exit(1);
        }
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exit(1);
      }
    });

  authCmd
    .command("rotate-key")
    .description("Rotate an API key (revoke old, create new with same metadata)")
    .argument("<id>", "API key ID to rotate")
    .option("--tenant <tenantId>", "Scope to this tenant (safer in multi-tenant setups)")
    .action(async (id: string, opts: any) => {
      try {
        const ark = await getArkClient();
        const result = await ark.apiKeyRotate(id, opts.tenant);
        console.log(chalk.green("API key rotated successfully."));
        console.log();
        console.log(`  ${chalk.bold("New key:")} ${result.key}`);
        console.log();
        console.log(chalk.yellow("Save the key now -- it cannot be retrieved later."));
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e.message}`));
        process.exit(1);
      }
    });
}
